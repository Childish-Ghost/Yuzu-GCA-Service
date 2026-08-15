//! 应用主界面：登录页 → 顶部导航（设备 / AI 聊天 / 日志）。
//! 所有 HTTP 结果经 HttpClient channel 轮询分发。

use crate::chat::ChatState;
use crate::devdetail::DeviceDetailState;
use crate::devices::DevicesState;
use crate::http::HttpClient;
use crate::login::LoginState;
use crate::logs::{LogKind, Logs};

#[derive(PartialEq, Clone, Copy)]
enum Page {
    Devices,
    Chat,
    Logs,
    /// 设备信息页
    Detail,
    /// 远程终端页
    Term,
}

pub struct GcaApp {
    http: HttpClient,
    login: LoginState,
    page: Page,
    devices: DevicesState,
    chat: ChatState,
    logs: Logs,
    /// 设备详情 + 远程终端
    detail: DeviceDetailState,
    /// 设备在线探测：每 15s 一次（防抖）
    last_refresh: std::time::Instant,
    /// 本机模式：不连 gca-server，直接操作本机 agent（单机场景）
    local_mode: bool,
    /// 上次向 gca-server 上报本机 IP 的时间（/heartbeat——DHCP IP 变动
    /// 后自动更新设备 URL，避免设备离线）
    last_heartbeat: std::time::Instant,
    /// /events 断线重连指数退避（秒，1→2→4→…→30 封顶；0 = 未安排）
    events_backoff: u64,
    /// /events 重连时间点
    events_retry_at: Option<std::time::Instant>,
}

impl Default for GcaApp {
    fn default() -> Self {
        let http = HttpClient::new();
        // 登录页部署形态检测：本机装了哪些组件（agent/term）→ 决定是否显示「本机模式」。
        // 纯控制端（未部署任何组件）隐藏本机模式，避免点了连不上。
        {
            let http = http.clone();
            std::thread::spawn(move || {
                let comps = crate::localmcp::local_components();
                http.notify("local_detect", true, serde_json::json!(comps).to_string());
            });
        }
        let mut app = Self {
            http,
            login: LoginState::default(),
            page: Page::Devices,
            devices: DevicesState::default(),
            chat: ChatState::default(),
            logs: Logs::default(),
            detail: DeviceDetailState::default(),
            last_refresh: std::time::Instant::now(),
            local_mode: false,
            last_heartbeat: std::time::Instant::now(),
            events_backoff: 0,
            events_retry_at: None,
        };
        // 自动登录（有保存的配置）
        if let Some((url, token)) = crate::login::load_saved() {
            app.login.url = url;
            app.login.token = token;
            app.login.busy = true;
            app.verify_login();
        }
        app
    }
}

impl GcaApp {
    /// 启动系统托盘线程（Rust 原生 Win32：图标 + 显示/退出菜单）。
    /// 失败不影响主功能。
    pub(crate) fn init_tray(&mut self) {
        let _ = crate::tray::spawn();
    }

    /// 登录验证：health + devices 双请求（后台线程）
    fn verify_login(&mut self) {
        self.login.busy = true;
        self.login.error.clear();
        let url = self.login.url.trim().trim_end_matches('/').to_string();
        let token = self.login.token.trim().to_string();
        self.http.get("login_health", &format!("{url}/health"), &token, 5);
        self.http.get("login_devices", &format!("{url}/devices"), &token, 5);
    }

    /// 本机模式：检查本机 agent（127.0.0.1:3001）是否可用
    fn verify_local_mode(&mut self) {
        self.login.busy = true;
        self.login.error.clear();
        let token = crate::login::load_saved()
            .map(|(_, t)| t)
            .unwrap_or_default();
        self.http.get("local_health", "http://127.0.0.1:3001/health", &token, 3);
    }

    /// 登录后核对本机注册状态：本机 machineId 是否已出现在设备列表。
    /// 注册请求在途（pending）时不覆盖状态，避免轮询结果被刷新覆盖。
    fn check_local_registration(&mut self, devices_body: &str) {
        if self.local_mode || self.login.reg_status == "pending" {
            return;
        }
        let mid = crate::localmcp::machine_id();
        // machineId 取不到（虚拟化/非标准 BIOS）时无法比对，跳过
        if mid.is_empty() {
            return;
        }
        let registered = serde_json::from_str::<serde_json::Value>(devices_body)
            .ok()
            .and_then(|v| v.get("devices").cloned())
            .and_then(|d| d.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .any(|d| d.get("machineId").and_then(|m| m.as_str()) == Some(mid.as_str()));
        self.login.reg_status = if registered { "registered".into() } else { "unregistered".into() };
    }

    /// 发起本机设备注册：POST /register → 确认码审批（owner 在飞书/微信或服务器页批准）
    fn request_local_registration(&mut self) {
        let mid = crate::localmcp::machine_id();
        if mid.is_empty() {
            self.login.reg_status = "error".into();
            self.login.reg_note = "无法读取本机 machineId，注册不可用".into();
            return;
        }
        let url = format!("{}/register", self.login.url);
        // S1：携设备自铸 token（服务端注册时写入注册表，不写 owner token）；
        // C12：设备名 hostname 派生（不再硬编码 gca-win11）
        let device_token = crate::login::ensure_device_token().unwrap_or_default();
        let body = serde_json::json!({
            "deviceName": crate::localmcp::device_name(),
            "machineId": mid,
            "port": 3001,
            "deviceToken": device_token,
        })
        .to_string();
        let token = self.login.token.clone();
        self.login.reg_busy = true;
        self.login.reg_status = "unknown".into();
        self.http.post("register_local", &url, &token, &body, 5);
    }

    /// 轮询注册审批状态（GET /ops/:id → approved 即注册完成）
    fn poll_registration(&mut self) {
        let id = self.login.reg_op_id.clone();
        if id.is_empty() {
            return;
        }
        let url = format!("{}/ops/{}", self.login.url, id);
        let token = self.login.token.clone();
        self.http.get("register_status", &url, &token, 5);
    }

    fn enter_local_mode(&mut self) {
        self.local_mode = true;
        self.login.done = true;
        self.login.url = "http://127.0.0.1:3001".to_string();
        // 本机 agent 的 MCP token 与保存的 gca-server token 一致（本机模式直连，
        // localmcp 拉起时以登录 token 为 GCA_MCP_TOKEN）
        let saved = crate::login::load_saved();
        let token = saved.as_ref().map(|(_, t)| t.clone()).unwrap_or_default();
        self.login.token = token.clone();
        self.logs.add("本机模式：直接连接本机 agent (127.0.0.1:3001)", LogKind::Ok);
        // 审计推送目标取保存的 gca-server 地址（若有）；本机模式无 server 则不注入
        crate::localmcp::ensure_running(&self.http, token, saved.as_ref().map(|(u, _)| u.as_str()), true);
        self.refresh_local_health();
    }

    /// 本机模式下的设备行（单台：本机）
    fn refresh_local_health(&mut self) {
        self.devices.rows.clear();
        self.devices.rows.push(crate::devices::DeviceRow {
            device: crate::devices::Device {
                name: "本机".to_string(),
                url: "http://127.0.0.1:3001/mcp".to_string(),
                machine_id: Some(crate::localmcp::machine_id()),
                transport: "streamable-http".to_string(),
                has_auth: false,
            },
            agent: None,
            term: None,
            uptime_base: 0,
            probed_at: 0,
        });
        self.devices.probes_pending = 1;
        let url = "http://127.0.0.1:3001/health".to_string();
        let token = self.login.token.clone();
        self.http.get("probe:本机", &url, &token, 5);
    }

    fn login_succeeded(&mut self, server_url: &str, token: &str) {
        self.login.done = true;
        self.login.url = server_url.to_string();
        self.login.token = token.to_string();
        crate::login::save(server_url, token);
        self.logs.add(format!("登录成功: {server_url}"), LogKind::Ok);
        // 本机也是被控设备：带起本机 MCP（后台线程，结果回日志）
        // 注入 GCA_SERVER_URL——agent 审计推送等需要（INT-005）
        crate::localmcp::ensure_running(&self.http, token.to_string(), Some(server_url), false);
        // 登录即上报本机 IP（DHCP 变动后设备 URL 立即校准）
        crate::localmcp::heartbeat(&self.http, server_url, token);
        self.last_heartbeat = std::time::Instant::now();
        self.refresh_devices();
        // 订阅 /events 设备状态事件流（事件驱动：免 15s 轮询逐设备探测）
        self.subscribe_events();
    }

    /// 订阅 /events（实时状态事件源）；本机模式无 gca-server，跳过
    fn subscribe_events(&mut self) {
        if self.local_mode {
            return;
        }
        let url = format!("{}/events", self.login.url.trim_end_matches('/'));
        let token = self.login.token.clone();
        self.http.subscribe_events(&url, &token);
        self.events_backoff = 0; // 新连接建立即重置退避
    }

    /// /events 断线：回退轮询 + 指数退避重连（1s→2s→4s→…→30s 封顶）
    fn schedule_events_reconnect(&mut self) {
        self.devices.live = false;
        let delay = if self.events_backoff == 0 { 1 } else { (self.events_backoff * 2).min(30) };
        self.events_backoff = delay;
        self.events_retry_at =
            Some(std::time::Instant::now() + std::time::Duration::from_secs(delay));
        self.logs.add(format!("实时状态连接断开，{delay}s 后重试（回退轮询）"), LogKind::Warn);
    }

    fn refresh_devices(&mut self) {
        if self.devices.list_pending { return; }
        self.devices.list_pending = true;
        let url = format!("{}/devices", self.login.url);
        self.http.get("devices_list", &url, &self.login.token, 5);
        self.logs.add("刷新设备列表", LogKind::Info);
    }

    /// 设备健康探测（列表回来之后，逐台；结果经 channel 回 UI）
    fn probe_devices(&mut self) {
        let urls: Vec<String> = self
            .devices
            .rows
            .iter()
            .map(|r| r.device.url.replace("/mcp", "/health"))
            .collect();
        let names: Vec<String> = self.devices.rows.iter().map(|r| r.device.name.clone()).collect();
        self.devices.probes_pending = urls.len();
        let token = self.login.token.clone();
        for (name, url) in names.into_iter().zip(urls) {
            // 3s 超时：局域网设备响应 <100ms，超时的都是离线（不等 5s+）
            self.http.get(format!("probe:{name}"), &url, &token, 3);
        }
    }

    /// 轮询后台请求结果并按 tag 分发。
    /// 有结果被处理 → 请求重绘（egui 空闲节流时后台响应也能立刻上屏——
    /// 终端 SSE 输出/输入回显的即时性依赖这里）。
    fn poll_http(&mut self, ctx: &egui::Context) {
        let mut any = false;
        while let Some(res) = self.http.poll() {
            any = true;
            match res.tag.as_str() {
                "login_health" => {
                    if !res.ok && !self.login.done {
                        self.login.busy = false;
                        self.login.error = format!("无法连接服务器: {}", res.error);
                    }
                }
                "login_devices" => {
                    self.login.busy = false;
                    let has_error = serde_json::from_str::<serde_json::Value>(&res.body)
                        .ok()
                        .and_then(|v| v.get("error").cloned())
                        .is_some();
                    if res.ok && !has_error && !self.login.done {
                        let url = self.login.url.trim().trim_end_matches('/').to_string();
                        let token = self.login.token.clone();
                        self.login_succeeded(&url, &token);
                        // 登录后核对本机注册状态（设备列表刚返回）
                        self.check_local_registration(&res.body);
                    } else if !self.login.done {
                        self.login.error = if res.ok { "密钥无效或已过期".into() } else { format!("请求失败: {}", res.error) };
                    }
                }
                "devices_list" => {
                    if res.ok {
                        self.devices.error.clear(); // 服务器恢复后清除残留错误提示
                        self.devices.apply_list(&res.body);
                        // SSE 实时模式免逐设备探测（卡顿根治——探测收权到 gca-server）；
                        // 轮询回退路径保留原行为
                        if !self.devices.live {
                            self.probe_devices();
                        }
                        // 设备列表变化（注册/撤销后）同步本机注册状态
                        self.check_local_registration(&res.body);
                    } else {
                        self.devices.error = res.error.clone();
                        self.devices.list_pending = false;
                    }
                }
                "local_detect" => {
                    self.login.local_components =
                        serde_json::from_str(&res.body).unwrap_or_default();
                }
                "register_local" => {
                    self.login.reg_busy = false;
                    if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body)
                            .unwrap_or_default();
                        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
                        let note = v.get("note").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        match status {
                            // 已注册（machineId 已在列表中）
                            "approved" => {
                                self.login.reg_status = "registered".into();
                                self.logs.add("本机设备已注册", LogKind::Ok);
                                self.refresh_devices();
                            }
                            // 等待 owner 确认
                            "pending" => {
                                self.login.reg_status = "pending".into();
                                self.login.reg_code =
                                    v.get("code").and_then(|c| c.as_str()).unwrap_or("").to_string();
                                self.login.reg_op_id =
                                    v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                                self.login.reg_note = note;
                                self.logs.add(
                                    format!("注册请求已提交，确认码 {}", self.login.reg_code),
                                    LogKind::Info,
                                );
                            }
                            _ => {
                                self.login.reg_status = "error".into();
                                self.login.reg_note = note;
                            }
                        }
                    } else {
                        self.login.reg_status = "error".into();
                        self.login.reg_note = res.error.clone();
                    }
                }
                // 本机 IP 心跳：updated=true（IP 变了）→ 刷新设备列表
                "heartbeat" => {
                    if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body).unwrap_or_default();
                        if v.get("updated").and_then(|u| u.as_bool()) == Some(true) {
                            self.logs.add("本机 IP 已更新（心跳）", LogKind::Ok);
                            self.refresh_devices();
                        }
                    }
                }
                "register_status" => {
                    if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body)
                            .unwrap_or_default();
                        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("pending");
                        match status {
                            "approved" => {
                                self.login.reg_status = "registered".into();
                                self.logs.add("注册已批准：本机设备已加入设备列表", LogKind::Ok);
                                self.refresh_devices();
                            }
                            "rejected" | "expired" => {
                                self.login.reg_status = "error".into();
                                self.login.reg_note = if status == "rejected" {
                                    "注册请求被拒绝".into()
                                } else {
                                    "确认码已过期，请重新发起注册".into()
                                };
                            }
                            _ => {} // 仍 pending，用户可稍后再点刷新
                        }
                    } else {
                        self.login.reg_note = res.error.clone();
                    }
                }
                // /events 设备状态事件流（事件驱动设备状态）：事件帧 → 应用；
                // closed → 回退轮询 + 指数退避重连
                t if t.starts_with("events:") => {
                    let evt_name = t.trim_start_matches("events:").to_string();
                    if evt_name == "closed" {
                        self.schedule_events_reconnect();
                    } else if let Some(evt) = crate::devices::parse_event(&evt_name, &res.body) {
                        let was_live = self.devices.live;
                        self.devices.live = true; // 收到事件帧 = 连接可用
                        if !was_live {
                            self.logs.add("已连接实时状态（事件驱动）", LogKind::Ok);
                        }
                        self.devices.apply_event(evt);
                    }
                }
                t if t.starts_with("probe:") => {
                    let name = t.trim_start_matches("probe:").to_string();
                    let (ok, uptime) = if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body).unwrap_or_default();
                        // process.uptime() 是浮点秒，JSON 里是 number——as_u64 解析会失败归零
                        let up = v.get("uptime").and_then(|u| u.as_u64().or_else(|| u.as_f64().map(|f| f as u64))).unwrap_or(0);
                        (v.get("status").and_then(|s| s.as_str()) == Some("ok"), up)
                    } else { (false, 0) };
                    self.devices.apply_probe(&name, ok, uptime);
                }
                "localmcp" => {
                    if res.ok {
                        self.logs.add(res.body.clone(), LogKind::Ok);
                    } else {
                        self.logs.add(res.body.clone(), LogKind::Warn);
                    }
                }
                "local_health" => {
                    self.login.busy = false;
                    if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body).unwrap_or_default();
                        if v.get("status").and_then(|s| s.as_str()) == Some("ok") {
                            self.enter_local_mode();
                            continue;
                        }
                        self.login.error = "本机 agent 未就绪".into();
                    } else {
                        self.login.error = format!("本机 agent 不可用: {}", res.error);
                    }
                }
                "scan_result" => {
                    self.login.scanning = false;
                    self.login.scan_results = serde_json::from_str(&res.body).unwrap_or_default();
                    if self.login.scan_results.is_empty() {
                        self.login.error = "未发现 gca-server（检查是否同网段、18790 端口）".into();
                    }
                }
                "chat_ai" => {
                    if res.ok {
                        self.chat.apply_reply(&res.body);
                    } else {
                        self.chat.apply_error(&res.error);
                        self.logs.add(format!("AI 聊天失败: {}", res.error), LogKind::Error);
                    }
                }
                // 设备详情：sysinfo / exec / confirm（tag 前缀区分设备）
                // term exec 响应为 MCP 包装（post 未解包）→ unwrap_mcp_body
                t if t.starts_with("sysinfo:") || t.starts_with("term:") || t.starts_with("confirm:") => {
                    if self.detail.open {
                        if res.ok {
                            let body = crate::http::unwrap_mcp_body(&res.body);
                            self.detail.apply_mcp_result(&body, "");
                        } else {
                            self.detail.apply_mcp_result("", &res.error);
                        }
                    }
                }
                // 终端 health：同步实际 shell 到显示（打开终端页/重连时）
                "term_health" => {
                    if res.ok {
                        let v = serde_json::from_str::<serde_json::Value>(&res.body).unwrap_or_default();
                        if let Some(shell) = v.get("shell").and_then(|s| s.as_str()) {
                            if self.detail.shell_kind != shell {
                                self.detail.shell_kind = shell.to_string();
                                self.logs.add(format!("终端 shell: {}", shell), LogKind::Info);
                            }
                        }
                    }
                }
                // term shell 切换结果（响应驱动：成功才重置终端重连，失败回滚）
                t if t.starts_with("term_shell:") => {
                    if res.ok {
                        self.detail.pending_shell = None;
                        self.detail.term = None; // 重建会话后重连（新 shell）
                        self.detail.term_sse_started = false;
                        self.logs.add(format!("终端已切换: {}", self.detail.shell_kind), LogKind::Ok);
                    } else {
                        // 切换失败：回滚 shell_kind（避免显示与实际的 shell 不一致）
                        if let Some(target) = self.detail.pending_shell.take() {
                            self.detail.shell_kind = if target == "cmd" { "powershell".to_string() } else { "cmd".to_string() };
                        }
                        self.logs.add(
                            format!("shell 切换失败: {} | body: {}", res.error, res.body.chars().take(120).collect::<String>()),
                            LogKind::Warn,
                        );
                    }
                }
                // 真终端 SSE 流（term_sse:{gen}）：输出块 → vte 解析；断开 → 允许重连
                t if t.starts_with("term_sse:") => {
                    let gen: u32 = t.strip_prefix("term_sse:").and_then(|g| g.parse().ok()).unwrap_or(0);
                    // 数据分支同样校验 gen——旧连接（切 shell/切设备后仍在流的
                    // SSE 线程）输出不混入新会话（df33c6d 修的双提示符的另一半）
                    if res.ok && gen == self.detail.term_conn_gen {
                        if let Some(tv) = &mut self.detail.term {
                            if !tv.connected {
                                // 重连/首次连接：清屏避免旧屏幕残留叠加
                                tv.clear_screen();
                                self.logs.add(format!("终端已连接: {}", self.detail.name), LogKind::Ok);
                            }
                            tv.connected = true;
                            if !res.body.is_empty() {
                                tv.feed(res.body.as_bytes());
                            }
                        }
                    } else if !res.ok && gen == self.detail.term_conn_gen {
                        // 只处理「最新代际」的断开——旧连接的断开通知
                        // （切换/重连后）不重置新连接（避免双连接重复 feed）
                        self.logs.add(
                            format!("终端连接断开: {}（{}）", self.detail.name, res.error),
                            LogKind::Warn,
                        );
                        // 在途输入回填（重连后 flush 重发，不丢字符）
                        let requeued = self.detail.term_link_lost();
                        if let Some(tv) = &mut self.detail.term {
                            tv.connected = false;
                        }
                        if requeued > 0 {
                            self.logs.add(
                                format!("输入重发（{}B，连接断开）", requeued),
                                LogKind::Warn,
                            );
                        }
                        self.detail.term_sse_started = false; // 下帧重连（2s 退避）
                    }
                }
                // 真终端输入响应（tag: term_input:{seq}——输入串行化，同一时刻
                // 至多一个 POST 在途）：成功 → 清在途标记；失败 → 精确回填该
                // chunk（与在途 POST 一一对应，不张冠李戴——避免丢字符+重复）。
                // seq 不匹配 = 迟到的旧 POST 响应（重发已在进行）→ 忽略，
                // 不误清新 POST 的在途标记（防重复发送）
                t if t.starts_with("term_input:") => {
                    let seq: u64 = t.strip_prefix("term_input:").and_then(|s| s.parse().ok()).unwrap_or(0);
                    if seq != self.detail.input_seq {
                        continue;
                    }
                    self.detail.input_in_flight = false;
                    if res.ok {
                        self.detail.last_input.clear();
                    } else {
                        let lost = std::mem::take(&mut self.detail.last_input);
                        if !lost.is_empty() {
                            let lost_len = lost.len();
                            if let Some(t) = &mut self.detail.term {
                                let mut retry = lost;
                                retry.extend_from_slice(&t.input_pending);
                                t.input_pending = retry;
                            }
                            self.logs.add(
                                format!("输入重发（{lost_len}B 前次失败）"),
                                LogKind::Warn,
                            );
                        }
                    }
                }
                // 真终端 resize 响应：失败 → 恢复 resize_pending（下帧重发；
                // 不恢复则尺寸丢失——shell 保持旧网格，下次窗口变化才校准）
                "term_resize" => {
                    if !res.ok {
                        if let Some((cols, rows)) = self.detail.last_resize.take() {
                            if let Some(t) = &mut self.detail.term {
                                t.resize_pending = Some((cols, rows));
                            }
                            self.logs.add(
                                format!("终端 resize 重发（{}x{} 前次失败）", cols, rows),
                                LogKind::Warn,
                            );
                        }
                    } else {
                        self.detail.last_resize = None;
                    }
                }
                // 目录树 file_list（tree:{name}:{path}）
                t if t.starts_with("tree:") => {
                    if self.detail.open {
                        let prefix = format!("tree:{}:", self.detail.name);
                        if let Some(path) = t.strip_prefix(&prefix) {
                            if res.ok {
                                self.detail.apply_tree_result(path, &res.body);
                            } else {
                                self.detail.apply_tree_result(path, &format!("{{\"status\":\"error\",\"error\":\"{}\"}}", res.error.replace('"', "\\\"")));
                            }
                        }
                    }
                }
                t if t.starts_with("rename:") => {
                    self.detail.apply_rename(res.ok, &res.error);
                    if res.ok {
                        self.logs.add(format!("设备重命名: {}", self.detail.name), LogKind::Ok);
                    }
                    self.refresh_devices();
                }
                t if t.starts_with("revoke:") => {
                    self.detail.apply_revoke(res.ok, &res.error);
                    if res.ok {
                        self.logs.add(format!("设备已撤销: {}", self.detail.name), LogKind::Warn);
                        self.detail.close();
                    }
                    self.refresh_devices();
                }
                _ => {}
            }
        }
        if any {
            ctx.request_repaint();
        }
    }
}

impl eframe::App for GcaApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_http(ctx);

        // 关闭请求拦截（X/Alt+F4）→ Win32 SW_HIDE 隐藏窗口（后台常驻）。
        // 不用 egui 的 ViewportCommand::Visible(false)——它会让事件循环停摆、
        // 命令失效（实测）；SW_HIDE 由 Rust 托盘线程执行，egui 以为窗口还在，
        // 托盘 SW_SHOW 唤醒后一切正常。托盘「退出」（exit_requested）才放行退出。
        if crate::tray::exit_requested() {
            // 退出 = 不再使用 GCA：一并结束设备服务（agent/term 无独立
            // UI，跟随桌面生命周期退出——下次打开桌面端自动重新拉起）。
            // 幂等：taskkill 对不存在的进程无副作用。
            crate::localmcp::kill_local_services();
        } else if ctx.input(|i| i.viewport().close_requested()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            crate::tray::hide_window();
        }

        // 登录后每 1s 请求轻量重绘：egui 空闲时不重绘 → update 不运行 →
        // 定时刷新不触发 → 设备状态/uptime 更新间隔不均匀（如 1分8秒
        // 跳到 1分32秒）。1fps 重绘开销可忽略。
        if self.login.done {
            ctx.request_repaint_after(std::time::Duration::from_secs(1));
        }

        // /events 断线重连（指数退避到点）
        if !self.local_mode && self.login.done {
            if let Some(at) = self.events_retry_at {
                if std::time::Instant::now() >= at {
                    self.events_retry_at = None;
                    self.subscribe_events();
                }
            }
        }

        // 登录态定时刷新设备：SSE 实时模式 60s 全量对齐一次（状态由事件驱动）；
        // 轮询回退 15s + 逐设备探测（现状逻辑）
        let refresh_interval = if self.devices.live { 60 } else { 15 };
        if self.login.done && self.last_refresh.elapsed().as_secs() >= refresh_interval {
            self.last_refresh = std::time::Instant::now();
            if self.local_mode {
                self.refresh_local_health();
            } else {
                self.refresh_devices();
                // 每 5 分钟上报本机 IP（DHCP 变动 → 设备 URL 自动更新）
                if self.last_heartbeat.elapsed().as_secs() >= 300 {
                    self.last_heartbeat = std::time::Instant::now();
                    let url = self.login.url.clone();
                    let token = self.login.token.clone();
                    crate::localmcp::heartbeat(&self.http, &url, &token);
                }
            }
        }

        if !self.login.done {
            self.show_login(ctx);
            return;
        }

        self.show_main(ctx);
    }
}

impl GcaApp {
    fn show_login(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(120.0);
            ui.vertical_centered(|ui| {
                ui.heading("GCA Desktop");
                ui.label("全局控制助手 · 连接控制服务器");
                ui.add_space(20.0);
                egui::Frame::default()
                    .fill(egui::Color32::from_rgb(26, 26, 25))
                    .stroke(egui::Stroke::new(1.0_f32, egui::Color32::from_rgb(40, 40, 40)))
                    .corner_radius(8.0)
                    .inner_margin(egui::Margin::symmetric(28, 24))
                    .show(ui, |ui| {
                        ui.set_width(340.0);
                        ui.label("服务器地址");
                        ui.add(egui::TextEdit::singleline(&mut self.login.url).hint_text("http://<服务器IP>:<端口>").desired_width(f32::INFINITY));
                        ui.add_space(8.0);
                        ui.label("密钥 (Token)");
                        ui.add(egui::TextEdit::singleline(&mut self.login.token).password(true).desired_width(f32::INFINITY));
                        ui.add_space(12.0);
                        let busy = self.login.busy;
                        let button_text = if busy { "连接中..." } else { "连接" };
                        if ui.add_enabled(!busy, egui::Button::new(button_text).fill(egui::Color32::from_rgb(57, 135, 229)).min_size(egui::vec2(ui.available_width(), 34.0))).clicked() {
                            self.verify_login();
                        }
                        ui.add_space(8.0);
                        // 嗅探局域网 gca-server
                        let scan_label = if self.login.scanning { "🔍 扫描中..." } else { "🔍 嗅探局域网服务器" };
                        if ui.add_enabled(!busy && !self.login.scanning, egui::Button::new(scan_label).min_size(egui::vec2(ui.available_width(), 30.0))).clicked() {
                            self.login.scanning = true;
                            self.login.scan_results.clear();
                            crate::scan::scan(&self.http);
                        }
                        // 嗅探结果：点选填入地址
                        if !self.login.scan_results.is_empty() {
                            ui.add_space(6.0);
                            ui.label(egui::RichText::new("发现服务器，点击选择：").size(11.0).color(egui::Color32::from_gray(140)));
                            for url in self.login.scan_results.clone() {
                                if ui.add(egui::Button::new(egui::RichText::new(&url).size(12.0)).min_size(egui::vec2(ui.available_width(), 26.0))).clicked() {
                                    self.login.url = url;
                                }
                            }
                        }
                        ui.add_space(8.0);
                        // 本机模式：不连 gca-server，直接操作本机 agent。
                        // 仅本机部署了 agent/term 时显示（纯控制端隐藏——本机模式无意义）。
                        // None = 组件检测未完成，先显示避免闪烁。
                        let show_local = self
                            .login
                            .local_components
                            .as_ref()
                            .map(|c| !c.is_empty())
                            .unwrap_or(true);
                        if show_local {
                            if ui.add_enabled(!busy, egui::Button::new("⚡ 本机模式（不连接服务器）").min_size(egui::vec2(ui.available_width(), 30.0))).clicked() {
                                self.verify_local_mode();
                            }
                        }
                        if !self.login.error.is_empty() {
                            ui.add_space(6.0);
                            ui.colored_label(egui::Color32::from_rgb(229, 57, 53), &self.login.error);
                        }
                    });
            });
        });
    }

    fn show_main(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("nav").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("GCA Desktop");
                ui.add_space(16.0);
                // 本机模式：无服务器，只有本机设备操作页
                let pages: &[(&str, Page)] = if self.local_mode {
                    &[("🖥 本机", Page::Devices), ("📋 日志", Page::Logs)]
                } else {
                    &[("📱 设备", Page::Devices), ("🤖 AI 聊天", Page::Chat), ("📋 日志", Page::Logs)]
                };
                for (label, page) in pages {
                    if ui.selectable_label(self.page == *page, *label).clicked() {
                        self.page = *page;
                    }
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("退出登录").clicked() {
                        self.login = LoginState::default();
                        self.devices = DevicesState::default();
                        self.chat = ChatState::default();
                        self.local_mode = false;
                        self.page = Page::Devices;
                        self.logs.add("已退出登录", LogKind::Warn);
                        return;
                    }
                    if self.local_mode {
                        ui.label(egui::RichText::new("⚡ 本机模式").color(egui::Color32::from_rgb(250, 178, 25)));
                    } else {
                        ui.label(format!("gca-server · {} 设备", self.devices.rows.len()));
                    }
                });
            });
        });

        match self.page {
            Page::Devices => self.show_devices(ctx),
            Page::Chat => self.show_chat(ctx),
            Page::Logs => self.show_logs(ctx),
            Page::Detail => self.show_detail(ctx),
            Page::Term => self.show_term(ctx),
        }
    }

    fn show_devices(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(if self.local_mode { "本机设备" } else { "已注册设备" });
                if ui.button("🔄 刷新").clicked() {
                    if self.local_mode {
                        self.refresh_local_health();
                    } else {
                        self.refresh_devices();
                    }
                }
                // 状态源指示：● 实时（/events 事件驱动）/ 探测中 / ○ 轮询回退
                if self.devices.live {
                    ui.colored_label(egui::Color32::from_rgb(12, 163, 12), "● 实时");
                } else if self.devices.probes_pending > 0 {
                    ui.label(format!("探测中... {}", self.devices.probes_pending));
                } else {
                    ui.colored_label(egui::Color32::from_gray(150), "○ 轮询");
                }
            });
            ui.separator();
            // 本机设备注册横幅（仅服务器模式；本机是受控设备但未注册/注册中时提示）
            let yellow = egui::Color32::from_rgb(250, 178, 25);
            let red = egui::Color32::from_rgb(229, 57, 53);
            let grey = egui::Color32::from_gray(150);
            let mut reg_action: Option<String> = None;
            if !self.local_mode {
                match self.login.reg_status.as_str() {
                    "unregistered" => {
                        ui.horizontal(|ui| {
                            ui.colored_label(yellow, "⚠ 本机设备未注册到该服务器");
                            if ui
                                .add_enabled(!self.login.reg_busy, egui::Button::new(if self.login.reg_busy { "提交中..." } else { "注册本机设备" }))
                                .clicked()
                            {
                                reg_action = Some("register".to_string());
                            }
                        });
                        ui.label(
                            egui::RichText::new("注册后此设备可被 AI 远程控制（本机 agent · 3001）")
                                .size(10.0)
                                .color(grey),
                        );
                    }
                    "pending" => {
                        ui.horizontal(|ui| {
                            ui.colored_label(yellow, "📋 注册请求已提交，确认码：");
                            ui.label(egui::RichText::new(&self.login.reg_code).strong().size(16.0));
                            if ui.button("刷新状态").clicked() {
                                reg_action = Some("poll".to_string());
                            }
                        });
                        ui.label(
                            egui::RichText::new("请在飞书/微信回复确认码，或在服务器管理页批准")
                                .size(10.0)
                                .color(grey),
                        );
                    }
                    "error" => {
                        ui.horizontal(|ui| {
                            let note = self.login.reg_note.clone();
                            ui.colored_label(red, if note.is_empty() { "注册失败" } else { &note });
                            if ui.button("重新注册").clicked() {
                                reg_action = Some("register".to_string());
                            }
                        });
                    }
                    _ => {}
                }
                if self.login.reg_status != "unknown" && self.login.reg_status != "registered" {
                    ui.separator();
                }
            }
            if !self.devices.error.is_empty() {
                ui.colored_label(red, &self.devices.error);
            }
            let mut clicked: Option<usize> = None;
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                for (i, row) in self.devices.rows.iter().enumerate() {
                    let frame = egui::Frame::default()
                        .fill(egui::Color32::from_rgb(26, 26, 25))
                        .stroke(egui::Stroke::new(1.0_f32, egui::Color32::from_rgb(40, 40, 40)))
                        .corner_radius(6.0)
                        .inner_margin(egui::Margin::symmetric(14, 10));
                    frame.show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.label(egui::RichText::new(&row.device.name).strong().size(14.0));
                                ui.label(egui::RichText::new(&row.device.url).size(11.0).color(egui::Color32::from_gray(140)));
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.button("📋 详情").clicked() {
                                    clicked = Some(i);
                                }
                                // 四态显示（事件驱动设备状态，docs/event-driven-plan.md）：
                                // 在线（绿）/ 仅 Agent（黄，term 不在线）/ 仅终端（蓝，agent
                                // 不在线）/ 离线（红，均确认离线）；均未确认 → 未知（灰过渡）
                                let (text, color) = match (row.agent, row.term) {
                                    (Some(true), Some(true)) => ("在线", egui::Color32::from_rgb(12, 163, 12)),
                                    (Some(true), _) => ("仅 Agent", egui::Color32::from_rgb(185, 126, 0)),
                                    (_, Some(true)) => ("仅终端", egui::Color32::from_rgb(57, 135, 229)),
                                    (None, None) => ("未知", egui::Color32::from_gray(150)),
                                    _ => ("离线", egui::Color32::from_rgb(229, 57, 53)),
                                };
                                ui.colored_label(color, text);
                                if row.online() {
                                    // display_uptime：探测基准 + 本地流逝（每秒跳动）
                                    ui.label(egui::RichText::new(format_uptime(row.display_uptime())).size(11.0).color(egui::Color32::from_gray(160)));
                                }
                            });
                        });
                    });
                    ui.add_space(4.0);
                }
                if self.devices.rows.is_empty() {
                    ui.label("无设备");
                }
            });
            // 注册横幅按钮动作
            match reg_action.as_deref() {
                Some("register") => self.request_local_registration(),
                Some("poll") => self.poll_registration(),
                _ => {}
            }
            // 点击详情 → 切到详情页并拉取 sysinfo
            if let Some(i) = clicked {
                if let Some(row) = self.devices.rows.get(i).cloned() {
                    self.detail.open(&row.device, row.online(), row.uptime_base, self.local_mode);
                    let url = self.login.url.clone();
                    let token = self.login.token.clone();
                    self.detail.request_sysinfo(&self.http, &url, &token);
                    self.page = Page::Detail;
                }
            }
        });
    }

    fn show_chat(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::bottom("chat_input").show(ctx, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                let sending = self.chat.sending;
                let send_label = if sending { "思考中..." } else { "发送" };
                ui.add_enabled(!sending, egui::TextEdit::singleline(&mut self.chat.input).hint_text("输入消息，回车发送").desired_width(f32::INFINITY));
                if ui.add_enabled(!sending, egui::Button::new(send_label).fill(egui::Color32::from_rgb(12, 100, 12))).clicked()
                    || (ui.input(|i| i.key_pressed(egui::Key::Enter)) && !sending)
                {
                    let url = self.login.url.clone();
                    let token = self.login.token.clone();
                    self.chat.send(&self.http, &url, &token);
                }
            });
            if !self.chat.error.is_empty() {
                ui.colored_label(egui::Color32::from_rgb(229, 57, 53), &self.chat.error);
            }
            ui.add_space(8.0);
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("AI 助手 · 会话 main（与飞书/微信同步）");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("清空记录").clicked() {
                        self.chat.clear();
                    }
                });
            });
            ui.separator();
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                for m in &self.chat.messages {
                    let (_color, align_right) = if m.role == "user" {
                        (egui::Color32::from_rgb(207, 228, 255), true)
                    } else {
                        (egui::Color32::from_gray(220), false)
                    };
                    let width = ui.available_width() * 0.8;
                    ui.with_layout(
                        if align_right { egui::Layout::right_to_left(egui::Align::TOP) } else { egui::Layout::left_to_right(egui::Align::TOP) },
                        |ui| {
                            egui::Frame::default()
                                .fill(if m.role == "user" { egui::Color32::from_rgb(13, 33, 55) } else { egui::Color32::from_rgb(26, 26, 25) })
                                .stroke(egui::Stroke::new(1.0_f32, egui::Color32::from_rgb(45, 45, 45)))
                                .corner_radius(8.0)
                                .inner_margin(egui::Margin::symmetric(12, 8))
                                .show(ui, |ui| {
                                    ui.set_max_width(width);
                                    ui.label(format_time(&m.ts));
                                    ui.add(egui::Label::new(&m.text).wrap());
                                });
                        },
                    );
                    ui.add_space(6.0);
                }
                if self.chat.sending {
                    ui.label("思考中...");
                }
            });
        });
    }

    /// 详情页共用顶部条：返回 + 标题 + 状态 + 信息/终端互切
    fn detail_head(&mut self, ui: &mut egui::Ui, current: Page) {
        let green = egui::Color32::from_rgb(12, 163, 12);
        let red = egui::Color32::from_rgb(229, 57, 53);
        let grey = egui::Color32::from_gray(150);
        ui.horizontal(|ui| {
            if ui.button("← 返回设备").clicked() {
                self.page = Page::Devices;
                self.detail.close();
            }
            ui.heading(format!("设备详情 · {}", self.detail.name));
            let (text, color) = if self.detail.online { ("在线", green) } else { ("离线", red) };
            ui.colored_label(color, text);
            if self.detail.online && self.detail.uptime > 0 {
                ui.label(egui::RichText::new(format_uptime(self.detail.uptime)).size(11.0).color(grey));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let btn = if current == Page::Detail {
                    ui.button("🖥 远程终端")
                } else {
                    ui.button("📋 设备信息")
                };
                if btn.clicked() {
                    self.page = if current == Page::Detail { Page::Term } else { Page::Detail };
                }
                ui.label(egui::RichText::new(&self.detail.url).size(11.0).color(grey));
            });
        });
        ui.separator();
    }

    /// 设备信息页（独立页面）：信息 + sysinfo + 管理
    fn show_detail(&mut self, ctx: &egui::Context) {
        use crate::devdetail::url_encode;
        egui::CentralPanel::default().show(ctx, |ui| {
            self.detail_head(ui, Page::Detail);
            let server_url = self.login.url.clone();
            let token = self.login.token.clone();
            let d = &mut self.detail;
            let red = egui::Color32::from_rgb(229, 57, 53);
            let grey = egui::Color32::from_gray(150);

            egui::ScrollArea::vertical().id_salt("info_page").auto_shrink([false, false]).show(ui, |ui| {
                // 设备信息
                egui::Grid::new("devinfo").num_columns(2).spacing([16.0, 6.0]).show(ui, |ui| {
                    ui.label(egui::RichText::new("名称").color(grey));
                    ui.label(&d.name);
                    ui.end_row();
                    ui.label(egui::RichText::new("机器标识 (machineId)").color(grey));
                    ui.label(if d.machine_id.is_empty() { "-" } else { &d.machine_id });
                    ui.end_row();
                    ui.label(egui::RichText::new("传输").color(grey));
                    ui.label(&d.transport);
                    ui.end_row();
                    ui.label(egui::RichText::new("认证").color(grey));
                    ui.label(if d.has_auth { "是" } else { "否" });
                    ui.end_row();
                    ui.label(egui::RichText::new("地址").color(grey));
                    ui.label(&d.url);
                    ui.end_row();
                });
                ui.separator();

                // 系统信息（全窗口展示）
                ui.label(egui::RichText::new("系统信息 (sysinfo)").strong());
                ui.add_space(4.0);
                if d.sysinfo_loading {
                    ui.label("加载中...");
                } else if d.sysinfo.is_empty() {
                    ui.label("无数据（设备离线或未响应）");
                } else {
                    egui::Grid::new("sysinfo_grid").num_columns(2).striped(true).spacing([16.0, 2.0]).show(ui, |ui| {
                        for (k, v) in &d.sysinfo {
                            ui.label(egui::RichText::new(k).color(grey));
                            ui.label(v);
                            ui.end_row();
                        }
                    });
                }
                ui.separator();

                // 管理操作（本机模式无 gca-server，隐藏重命名/撤销）
                let local = self.local_mode;
                if !local {
                    ui.label(egui::RichText::new("管理").strong());
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.label("重命名");
                        ui.add(egui::TextEdit::singleline(&mut d.rename_input).desired_width(200.0));
                        if ui.add_enabled(!d.rename_busy, egui::Button::new("确定")).clicked() {
                            let new_name = d.rename_input.trim().to_string();
                            let old = d.name.clone();
                            if !new_name.is_empty() && new_name != old {
                                d.rename_busy = true;
                                let url = format!("{server_url}/devices/{}/rename", url_encode(&old));
                                let body = serde_json::json!({ "newName": new_name }).to_string();
                                self.http.post(format!("rename:{old}"), &url, &token, &body, 5);
                                self.logs.add(format!("重命名请求: {old} → {new_name}"), LogKind::Info);
                            }
                        }
                        ui.separator();
                        if ui.button(
                            egui::RichText::new(if d.revoke_armed { "再次点击确认撤销" } else { "撤销设备" })
                                .color(if d.revoke_armed { red } else { egui::Color32::from_gray(200) }),
                        ).clicked() {
                            if d.revoke_armed {
                                d.revoke_armed = false;
                                let name = d.name.clone();
                                let url = format!("{server_url}/devices/{}/revoke", url_encode(&name));
                                self.http.post(format!("revoke:{name}"), &url, &token, "{}", 5);
                                self.logs.add(format!("撤销请求: {name}"), LogKind::Warn);
                            } else {
                                d.revoke_armed = true;
                            }
                        }
                    });
                    if !d.error.is_empty() {
                        ui.colored_label(red, &d.error);
                    }
                    ui.label(egui::RichText::new("撤销后设备需重新注册才能使用").size(10.0).color(grey));
                }
            });
        });
    }

    /// 远程终端页（独立页面）：左侧目录树 + 右侧真终端（ConPTY + SSE + vte）
    fn show_term(&mut self, ctx: &egui::Context) {
        let server_url = self.login.url.clone();
        let token = self.login.token.clone();

        // 确保终端会话存在并连接 SSE（进入页面/断开重连）
        self.detail.ensure_term(&self.http, &server_url, &token);
        // 输入批量 flush + resize（帧驱动）
        self.detail.flush_term_input(&self.http, &server_url, &token);
        self.detail.flush_term_resize(&self.http, &server_url, &token);

        // cd 导航推进：沿 pending_expand 路径逐层展开（每层加载完成后继续）
        if self.detail.pending_expand.is_some() {
            self.detail.expand_step(&self.http, &server_url, &token);
        }

        // 首次进入：等 sysinfo 拿到平台/盘符后按平台建树根
        // （win32 → 盘符列表；linux/android → 单根 "/"）
        if self.detail.tree_roots.is_empty() && self.detail.online {
            if self.detail.platform.is_empty()
                && self.detail.sysinfo_error.is_empty()
                && !self.detail.sysinfo_loading
            {
                self.detail.request_sysinfo(&self.http, &server_url, &token);
            } else if !self.detail.platform.is_empty() || !self.detail.sysinfo_error.is_empty() {
                // 平台已知，或 sysinfo 失败（fallback 单根）
                self.detail.load_root();
            }
        }

        // 左侧：目录树（懒加载，点箭头展开；点目录名设为终端工作目录）
        egui::SidePanel::left("tree_panel")
            .resizable(true)
            .default_width(230.0)
            .min_width(140.0)
            .show(ctx, |ui| {
                ui.add_space(4.0);
                // Shell 切换（仅 Windows agent-rs 设备：cmd / Windows PowerShell）
                if self.detail.platform == "win32" {
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Shell:").size(11.0).color(egui::Color32::from_gray(150)));
                        let current = self.detail.shell_kind.clone();
                        let mut changed = false;
                        let mut new_shell = String::new();
                        for (label, kind) in [("cmd", "cmd"), ("PowerShell", "powershell")] {
                            if ui
                                .selectable_label(current == kind, label)
                                .clicked()
                            {
                                new_shell = kind.to_string();
                                changed = true;
                            }
                        }
                        if changed {
                            self.detail.switch_shell(&self.http, &server_url, &token, &new_shell);
                        }
                    });
                    ui.separator();
                }
                ui.label(egui::RichText::new("📁 目录").size(12.0).color(egui::Color32::from_gray(150)));
                ui.separator();
                egui::ScrollArea::vertical()
                    .id_salt("tree_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let d = &mut self.detail;
                        let mut actions = Vec::new();
                        let browse = d.tree_browse.clone();
                        let cwd = d.tree_selected.clone();
                        // 工作目录概念仅 Android 需要（Windows/Linux 命令里 cd 即可）
                        let show_cwd = d.platform == "android";
                        crate::devdetail::DeviceDetailState::render_tree(
                            ui, &d.tree_roots, 0, &browse, &cwd, show_cwd, &mut actions,
                        );
                        for a in actions {
                            match a {
                                crate::devdetail::TreeAction::Toggle(path) => {
                                    d.toggle_tree(&self.http, &server_url, &token, &path);
                                }
                                crate::devdetail::TreeAction::Browse(path) => {
                                    d.tree_browse = path;
                                }
                                crate::devdetail::TreeAction::SetCwd(path) => {
                                    d.tree_selected = path;
                                }
                                crate::devdetail::TreeAction::CopyPath(path) => {
                                    ctx.copy_text(path.clone());
                                    self.logs.add(format!("已复制路径: {path}"), LogKind::Info);
                                }
                            }
                        }
                    });
            });

        // 底部：连接状态栏 + shell 切换（真终端直接键盘输入，无命令输入框）
        egui::TopBottomPanel::bottom("term_status").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                let connected = self.detail.term.as_ref().map(|t| t.connected).unwrap_or(false);
                let (text, color) = if connected {
                    ("● 已连接", egui::Color32::from_rgb(12, 163, 12))
                } else {
                    ("○ 连接中...", egui::Color32::from_rgb(250, 178, 25))
                };
                ui.colored_label(color, text);
                // Shell 切换（Windows：cmd / PowerShell，重建 ConPTY 会话）
                if self.detail.platform == "win32" {
                    ui.separator();
                    let current = self.detail.shell_kind.clone();
                    let mut changed = false;
                    let mut new_shell = String::new();
                    for (label, kind) in [("cmd", "cmd"), ("PowerShell", "powershell")] {
                        if ui.selectable_label(current == kind, label).clicked() {
                            new_shell = kind.to_string();
                            changed = true;
                        }
                    }
                    if changed {
                        // 响应驱动：POST /term/shell 成功才重置终端重连（term_shell
                        // 分支处理）——避免竞态：请求未完成时旧会话被误用（选了 cmd
                        // 但实际还是 PowerShell）
                        self.detail.switch_shell(&self.http, &server_url, &token, &new_shell);
                    }
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new("Ctrl+C 中断 · Ctrl+V 粘贴 · 直接键入").size(10.0).color(egui::Color32::from_gray(150)));
                });
            });
            ui.add_space(4.0);
        });

        // 终端主区：真终端网格渲染（vte 屏幕缓冲 → egui 行绘制）。
        // 深色背景：空白行与背景融合（减少「空行溢出」视觉，wt 风格）
        egui::CentralPanel::default()
            .frame(egui::Frame::default().fill(egui::Color32::from_rgb(12, 12, 12)))
            .show(ctx, |ui| {
            self.detail_head(ui, Page::Term);
            let Some(t) = self.detail.term.as_mut() else { return };
            if !t.connected {
                ui.colored_label(egui::Color32::from_rgb(250, 178, 25), "正在连接终端...");
            }
            // 尺寸计算（等宽字体字符网格）→ resize 防抖
            let font = egui::FontId::monospace(13.0);
            let char_w = ui.fonts(|f| f.glyph_width(&font, ' ').max(1.0));
            let line_h = ui.fonts(|f| f.row_height(&font));
            let avail = ui.available_size();
            let cols = ((avail.x - 12.0) / char_w).floor().max(20.0) as u16;
            let rows = ((avail.y - 8.0) / line_h).floor().max(5.0) as u16;
            if cols != t.screen().cols() as u16 || rows != t.screen().rows() as u16 {
                t.screen_mut().resize(cols as usize, rows as usize);
                t.resize_pending = Some((cols, rows));
            }
            // 键盘输入 → 字节流（批量缓冲）。
            // 注意：egui 对同一按键会同时产生 Text（字符）和 Key（按键）事件——
            // 控制字符（回车/退格/Tab）只走 Key 的 key_bytes（避免 Text("\n") +
            // Key(\r) 双发 → 双回车/双提示符）；可打印字符（含中文 IME）走 Text。
            // 焦点门控：点击终端区域才接收键盘（防止点完按钮/切换器后打字误发远程）
            let term_rect = ui.max_rect();
            if ui.input(|i| i.pointer.any_pressed()) {
                self.detail.term_focused = ui.rect_contains_pointer(term_rect);
            }
            // 未聚焦（没点击过终端区域）时按键不转发远程 shell
            let events = if self.detail.term_focused {
                ui.input(|i| i.events.clone())
            } else {
                Vec::new()
            };
            for ev in events {
                match ev {
                    egui::Event::Text(s) => {
                        if s.chars().all(|c| !c.is_control()) {
                            t.queue_input(s.as_bytes());
                        }
                    }
                    egui::Event::Paste(s) => t.queue_input(s.as_bytes()),
                    egui::Event::Key { key, pressed: true, modifiers, .. } => {
                        if let Some(b) = key_bytes(key, modifiers) {
                            t.queue_input(&b);
                        }
                    }
                    _ => {}
                }
            }
            // 网格渲染
            // 顶对齐（内容少时不底对齐——避免空白行把内容挤出视口）；
            // 输出/输入时 need_scroll 手动滚到底
            let mut last_rect: Option<egui::Rect> = None;
            egui::ScrollArea::both()
                .id_salt("term_grid")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    let (cx, cy) = t.screen().cursor();
                    let cursor_on = t.screen().cursor_visible();
                    let rows_n = t.screen().rows();
                    // wt 风格：行间无隙 + 行文本单 label 禁止换行（超宽截断）。
                    // 空白行策略（关键）：只跳过【前导】（内容未开始的空行，
                    // 顶对齐紧凑）和【尾部】（光标行之后的空行）——**中间的
                    // 空白行必须渲染占位**：跳过中间行会让相邻行字符视觉拼接
                    // （实测：输入 "2" 却显示 "2s"——s 是上上行残留）+ PS 光标
                    // 重绘时行数减少（输出"吞行"）。行序严格对应网格。
                    ui.spacing_mut().item_spacing.y = 0.0;
                    let mut started = false;
                    for y in 0..rows_n {
                        let row = t.screen().line(y);
                        let blank = row.iter().all(|c| c.ch == ' ' || c.ch == '\u{0}');
                        // 光标行永远渲染（光标块要画）；空白行跳过前导/尾部
                        if y != cy && blank && (!started || y > cy) {
                            continue;
                        }
                        if !blank {
                            started = true;
                        }
                        let mut text = String::with_capacity(row.len());
                        for cell in row.iter() {
                            text.push(if cell.ch == '\u{0}' { ' ' } else { cell.ch });
                        }
                        // 行前景色：取第一个非默认
                        let fg = row
                            .iter()
                            .find(|c| c.fg != crate::termview::Color::Default)
                            .map(|c| egui_color(&c.fg))
                            .unwrap_or(egui::Color32::from_gray(230));
                        let resp = ui.add(
                            egui::Label::new(egui::RichText::new(&text).font(font.clone()).color(fg))
                                .wrap_mode(egui::TextWrapMode::Extend),
                        );
                        last_rect = Some(resp.rect);
                        // 光标：painter 画反色块（覆盖当前字符位置）。
                        // 注意：cx 是列号（字符计数）——用 chars().nth 取字符，
                        // 不能用 text[cx..]（字节索引——中文多字节会 panic）
                        if cursor_on && y == cy {
                            let rect = resp.rect;
                            let x = rect.min.x + cx as f32 * char_w;
                            let painter = ui.painter();
                            painter.rect_filled(
                                egui::Rect::from_min_size(
                                    egui::pos2(x, rect.min.y),
                                    egui::vec2(char_w, line_h),
                                ),
                                0.0,
                                fg,
                            );
                            let ch = text.chars().nth(cx).unwrap_or(' ');
                            painter.text(
                                egui::pos2(x, rect.min.y),
                                egui::Align2::LEFT_TOP,
                                ch.to_string(),
                                font.clone(),
                                egui::Color32::BLACK,
                            );
                        }
                    }
                });
            // 输出/输入后滚到底部（顶对齐 + 跟随）
            if t.need_scroll {
                if let Some(rect) = last_rect {
                    ui.scroll_to_rect(rect, Some(egui::Align::BOTTOM));
                }
                t.need_scroll = false;
            }
            // 帧驱动节流：已连接且输入待发 → 10ms 内再来帧（flush 窗口——输入
            // 延迟不变）；空闲/断开 → 100ms（光标/状态刷新；断开时 flush 会
            // 直接返回，不能因此 8ms 空转）。SSE 输出/HTTP 响应到达时 poll_http
            // 已 request_repaint 立即唤醒——空闲不再 60fps 全量重绘。
            if t.connected && !t.input_pending.is_empty() {
                ui.ctx().request_repaint_after(std::time::Duration::from_millis(8));
            } else {
                ui.ctx().request_repaint_after(std::time::Duration::from_millis(100));
            }
        });
    }

    fn show_logs(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("运行日志");
                if ui.button("清空日志").clicked() {
                    self.logs.clear();
                }
            });
            ui.separator();
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                for e in self.logs.iter() {
                    let color = match e.kind {
                        LogKind::Info => egui::Color32::from_gray(160),
                        LogKind::Ok => egui::Color32::from_rgb(12, 163, 12),
                        LogKind::Warn => egui::Color32::from_rgb(250, 178, 25),
                        LogKind::Error => egui::Color32::from_rgb(229, 57, 53),
                    };
                    ui.colored_label(color, format!("[{}] {}", e.ts, e.msg));
                }
            });
        });
    }
}

/// 终端 ANSI 16 色 → egui 颜色（base16 近似）
const ANSI_COLORS: [egui::Color32; 16] = [
    egui::Color32::from_rgb(0x00, 0x00, 0x00), // 0 黑
    egui::Color32::from_rgb(0xcd, 0x31, 0x31), // 1 红
    egui::Color32::from_rgb(0x0d, 0x9c, 0x0d), // 2 绿
    egui::Color32::from_rgb(0xfa, 0xb5, 0x2e), // 3 黄
    egui::Color32::from_rgb(0x4d, 0x80, 0xff), // 4 蓝
    egui::Color32::from_rgb(0xff, 0x5f, 0xaf), // 5 品红
    egui::Color32::from_rgb(0x1a, 0xaf, 0xff), // 6 青
    egui::Color32::from_rgb(0xe6, 0xe6, 0xe6), // 7 白
    egui::Color32::from_rgb(0x66, 0x66, 0x66), // 8 亮黑
    egui::Color32::from_rgb(0xff, 0x6c, 0x60), // 9
    egui::Color32::from_rgb(0x3f, 0xb0, 0x3f), // 10
    egui::Color32::from_rgb(0xff, 0xd9, 0x5f), // 11
    egui::Color32::from_rgb(0x74, 0xa8, 0xff), // 12
    egui::Color32::from_rgb(0xff, 0x73, 0xfd), // 13
    egui::Color32::from_rgb(0x36, 0xc9, 0xff), // 14
    egui::Color32::from_rgb(0xff, 0xff, 0xff), // 15 亮白
];

/// 终端颜色 → egui 颜色
fn egui_color(c: &crate::termview::Color) -> egui::Color32 {
    match c {
        crate::termview::Color::Default => egui::Color32::from_gray(230),
        crate::termview::Color::Ansi(i) => ANSI_COLORS[*i as usize % 16],
        crate::termview::Color::Rgb(r, g, b) => egui::Color32::from_rgb(*r, *g, *b),
    }
}

/// 键盘 → 终端字节流（Windows 惯例：Ctrl+C=中断发送，Ctrl+V=粘贴本地处理）
fn key_bytes(key: egui::Key, m: egui::Modifiers) -> Option<Vec<u8>> {
    use egui::Key::*;
    if m.ctrl && key == C {
        return Some(vec![0x03]); // 中断（发送）
    }
    if m.ctrl && key == V {
        return None; // 粘贴：由 Event::Paste 处理
    }
    if m.ctrl && !m.alt {
        // Ctrl+字母 → 0x01..=0x1a（发送）
        if let Some(idx) = [
            A, B, D, E, F, G, H, I, J, K, L, N, O, P, Q, R, S, T, U, W, X, Y, Z,
        ]
        .iter()
        .position(|&k| k == key)
        {
            // A=0x01：A 在数组 index 0 → 0x01；B=1→0x02（跳过 C/V 占位需校正）
            let map = [1u8, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26];
            return Some(vec![map[idx]]);
        }
    }
    let mut out = Vec::new();
    if m.alt {
        out.push(0x1b);
    }
    let tail: &[u8] = match key {
        Enter => b"\r",
        Backspace => b"\x08",
        Tab => b"\t",
        Escape => b"\x1b",
        ArrowUp => b"\x1b[A",
        ArrowDown => b"\x1b[B",
        ArrowRight => b"\x1b[C",
        ArrowLeft => b"\x1b[D",
        Home => b"\x1b[H",
        End => b"\x1b[F",
        Delete => b"\x1b[3~",
        PageUp => b"\x1b[5~",
        PageDown => b"\x1b[6~",
        Insert => b"\x1b[2~",
        F1 => b"\x1bOP",
        F2 => b"\x1bOQ",
        F3 => b"\x1bOR",
        F4 => b"\x1bOS",
        F5 => b"\x1b[15~",
        F6 => b"\x1b[17~",
        F7 => b"\x1b[18~",
        F8 => b"\x1b[19~",
        F9 => b"\x1b[20~",
        F10 => b"\x1b[21~",
        F11 => b"\x1b[23~",
        F12 => b"\x1b[24~",
        _ => return None,
    };
    out.extend_from_slice(tail);
    Some(out)
}

fn format_uptime(s: u64) -> String {
    if s < 60 { format!("{s}秒") }
    else if s < 3600 { format!("{}分{}秒", s / 60, s % 60) }
    else if s < 86400 { format!("{}小时{}分", s / 3600, s % 3600 / 60) }
    else { format!("{}天{}小时", s / 86400, s % 86400 / 3600) }
}

fn format_time(ts: &u64) -> String {
    let secs = ts / 1000;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}")
}
