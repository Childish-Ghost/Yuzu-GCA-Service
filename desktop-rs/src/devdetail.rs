//! 设备详情 + 远程终端：点击设备行打开详情窗。
//! 设备 MCP（sysinfo/exec/confirm）直连设备端点，Bearer 用 gca-server token
//! （与 Tauri 版行为一致；设备端 dev mode 无 token 时天然兼容）；
//! rename/revoke 走 gca-server REST（服务端持有设备配对 token，不暴露给客户端）。

use crate::devices::Device;
use crate::http::HttpClient;

/// 目录树节点（懒加载：children=None 表示尚未请求子目录）
pub struct TreeDir {
    pub name: String,
    pub path: String,
    pub expanded: bool,
    pub loading: bool,
    pub error: String,
    pub children: Option<Vec<TreeDir>>,
}

/// 树交互动作（渲染时收集，渲染后统一执行——避免渲染中可变借用冲突）
pub enum TreeAction {
    /// 展开/折叠（▸/▾）
    Toggle(String),
    /// 浏览选中（单击目录名，不高亮为 cwd）
    Browse(String),
    /// 设为工作目录（⚡ 图标 / 右键菜单）
    SetCwd(String),
    /// 复制路径（右键菜单）
    CopyPath(String),
}

#[derive(Default)]
pub struct DeviceDetailState {
    pub open: bool,
    pub name: String,
    pub url: String,
    pub online: bool,
    pub uptime: u64,
    /// 直连模式（本机模式）：MCP 直接走 /mcp，不走 gca-server 代理
    pub direct: bool,
    pub machine_id: String,
    pub transport: String,
    pub has_auth: bool,
    /// sysinfo 快照，格式化为 (label, value) 行
    pub sysinfo: Vec<(String, String)>,
    pub sysinfo_loading: bool,
    pub sysinfo_error: String,
    pub rename_input: String,
    pub rename_busy: bool,
    /// 撤销两段式确认
    pub revoke_armed: bool,
    pub error: String,
    /// 左侧目录树（懒加载）+ 当前工作目录（cwd）
    pub tree_roots: Vec<TreeDir>,
    pub tree_selected: String,
    /// 浏览选中（单击高亮，与 cwd 区分）
    pub tree_browse: String,
    /// 设备平台（sysinfo 的 os.platform：win32/linux/android）——树根策略依据
    pub platform: String,
    /// Windows 盘符列表（win32 树根；linux/android 为空 → 单根 "/"）
    pub drives: Vec<String>,
    /// 待展开的路径（cd 导航：沿路径逐层加载，加载回调后由 UI 帧驱动继续）
    pub pending_expand: Option<String>,
    /// 终端 shell 类型（"cmd" / "powershell"，Windows 可选；切换走 term 服务）
    pub shell_kind: String,
    /// 真终端（C-1：portable-pty + SSE 流式 + vte 解析）——终端页打开时创建
    pub term: Option<crate::termview::TermView>,
    /// 防重复发起 SSE 连接（断开后重置允许重连）
    pub term_sse_started: bool,
    /// shell 切换请求在途（响应成功才重置终端重连——避免竞态用旧会话）
    pub pending_shell: Option<String>,
    /// 连接代际（每次发起连接递增——旧连接的断开通知不重置新连接，
    /// 避免重连产生双连接 → 同一输出 feed 两次 → 屏幕叠加/双提示符）
    pub term_conn_gen: u32,
    /// 输入 POST 是否在途。输入串行化：同一时刻至多一个 /term/input POST——
    /// 否则两个 POST 并行在途时失败通知无法对应到具体哪个 chunk
    /// （单槽位 last_input 会张冠李戴：旧 chunk 丢失、新 chunk 重复）
    pub input_in_flight: bool,
    /// 当前在途输入 POST 的序列号（每次 flush 递增）。响应 tag 带 seq——
    /// 迟到的旧 POST 响应（重发后）忽略，不误清新 POST 的在途标记（防重复发送）
    pub input_seq: u64,
    /// 最近发送的输入字节（对应在途 POST；失败时回填重试，成功/断开时清空）
    pub last_input: Vec<u8>,
    /// 最近一次发送的 resize（POST 失败时恢复 resize_pending 重试）
    pub last_resize: Option<(u16, u16)>,
    /// 最近一次 SSE 连接发起时间（重连退避：断开后不立刻帧级重连轰炸）
    pub last_sse_attempt: Option<std::time::Instant>,
    /// 终端区域是否获得键盘焦点（点击过终端区域）——门控键盘事件，
    /// 防止点击其他控件后继续打字误发远程 shell（2026-08-11 审查修复）
    pub term_focused: bool,
}

impl DeviceDetailState {
    pub fn open(&mut self, device: &Device, online: bool, uptime: u64, direct: bool) {
        self.open = true;
        self.name = device.name.clone();
        self.url = device.url.clone();
        self.online = online;
        self.uptime = uptime;
        self.direct = direct;
        self.machine_id = device.machine_id.clone().unwrap_or_default();
        self.transport = device.transport.clone();
        self.has_auth = device.has_auth;
        self.sysinfo.clear();
        self.sysinfo_loading = false;
        self.sysinfo_error.clear();
        self.rename_input = device.name.clone();
        self.rename_busy = false;
        self.revoke_armed = false;
        self.error.clear();
        self.tree_roots.clear();
        self.tree_selected.clear();
        self.tree_browse.clear();
        self.platform.clear();
        self.drives.clear();
        self.pending_expand = None;
        self.shell_kind = "cmd".to_string();
        self.term = None;
        self.term_sse_started = false;
        self.pending_shell = None;
        self.term_conn_gen = 0;
        self.input_in_flight = false;
        self.input_seq = 0;
        self.last_input.clear();
        self.last_resize = None;
        self.last_sse_attempt = None;
        self.term_focused = false;
    }

    pub fn close(&mut self) {
        self.open = false;
        self.term_focused = false;
    }

    /// MCP 端点：本机模式直连 /mcp；否则经 gca-server 代理
    /// （设备配对 token 只在网关侧，远程设备客户端不直连）
    fn proxy_url(&self, server_url: &str) -> String {
        if self.direct {
            format!("{server_url}/mcp")
        } else {
            format!("{server_url}/device/{}/mcp", url_encode(&self.name))
        }
    }

    /// 用户终端端点（/term）：真终端服务（SSE 流 + 输入/调整大小）。
    /// 仅 agent-rs（Windows）提供；node client 设备无此端点。
    fn proxy_url_term(&self, server_url: &str) -> String {
        if self.direct {
            format!("{server_url}/term")
        } else {
            format!("{server_url}/device/{}/term", url_encode(&self.name))
        }
    }

    /// 确保终端会话存在并连接 SSE（进入终端页/断开重连时调用；防重复发起）。
    /// 重连退避：断开后 2s 内不发起新连接——否则失败通知 → 下帧立刻重连 →
    /// 秒败（设备离线）→ 以帧率狂发连接线程。
    const SSE_RECONNECT_BACKOFF_MS: u64 = 2000;

    pub fn ensure_term(&mut self, http: &HttpClient, server_url: &str, token: &str) {
        if self.term.is_none() {
            self.term = Some(crate::termview::TermView::new(100, 30));
            self.term_sse_started = false;
            // 本帧不连接：等 show_term 渲染循环把网格 resize 到窗口实际尺寸，
            // 下一帧带尺寸连接——gca-term 用正确网格启动 shell（PSReadLine
            // 行号不偏移——100x30 启动后 resize 会导致提示符错位/缩进）
            return;
        }
        let backoff_ok = self
            .last_sse_attempt
            .map(|t| t.elapsed().as_millis() as u64 >= Self::SSE_RECONNECT_BACKOFF_MS)
            .unwrap_or(true);
        if !self.term_sse_started && backoff_ok {
            self.term_sse_started = true;
            self.last_sse_attempt = Some(std::time::Instant::now());
            self.term_conn_gen = self.term_conn_gen.wrapping_add(1);
            let gen = self.term_conn_gen;
            let (cols, rows) = {
                let t = self.term.as_ref().unwrap();
                (t.screen().cols() as u16, t.screen().rows() as u16)
            };
            // query 带网格尺寸 → gca-term 会话创建即用正确尺寸（wt 同时序）
            let url = format!("{}/sse?cols={cols}&rows={rows}", self.proxy_url_term(server_url));
            crate::logs::file_log("INFO", &format!("发起终端连接: {} gen={} ({}x{})", self.name, gen, cols, rows));
            http.get_sse(format!("term_sse:{gen}"), &url, token);
            // 同步实际 shell（health 返回——避免显示与 agent 会话不一致）
            let hurl = format!("{}/health", self.proxy_url_term(server_url));
            http.get("term_health", &hurl, token, 5);
        }
    }

    /// 发送输入缓冲（批量：10ms 攒一次）——由 app 帧驱动。
    /// 串行化：上一 POST 未回时继续攒（input_pending），不回取——保证失败
    /// 通知能对应到确切 chunk（last_input 与在途 POST 一一对应）。
    pub fn flush_term_input(&mut self, http: &HttpClient, server_url: &str, token: &str) {
        if self.input_in_flight {
            return;
        }
        let Some(t) = self.term.as_mut() else { return };
        if !t.connected || !t.input_due() {
            return;
        }
        let data = t.take_input();
        if data.is_empty() {
            return;
        }
        self.input_in_flight = true;
        self.input_seq = self.input_seq.wrapping_add(1);
        let seq = self.input_seq;
        self.last_input = data.clone();
        let url = format!("{}/input", self.proxy_url_term(server_url));
        let body = serde_json::json!({ "data": crate::http::base64_encode(&data) }).to_string();
        http.post(format!("term_input:{seq}"), &url, token, &body, 5);
    }

    /// 发送 resize（窗口尺寸变化防抖）——由 app 帧驱动。
    /// 记录 last_resize：POST 失败时 app 侧恢复 resize_pending 重试。
    /// 兜底：连接后若 ConPTY 尺寸（last_sent）与屏幕网格不一致则补发——
    /// 连接前的 resize 只在本地网格生效（!connected 时 flush 直接返回），
    /// 不补发则 ConPTY 保持默认 100x30 → shell 按 30 行渲染而显示区行数
    /// 不同 → 提示符错位（"倒数第二行"）+ PS 重绘错位（双提示符）。
    pub fn flush_term_resize(&mut self, http: &HttpClient, server_url: &str, token: &str) {
        let Some(t) = self.term.as_mut() else { return };
        if !t.connected {
            return;
        }
        let (cols, rows) = (t.screen().cols() as u16, t.screen().rows() as u16);
        if t.resize_pending.is_none() && t.last_sent_size != Some((cols, rows)) {
            t.resize_pending = Some((cols, rows));
        }
        if let Some((cols, rows)) = t.resize_pending.take() {
            t.last_sent_size = Some((cols, rows));
            self.last_resize = Some((cols, rows));
            let url = format!("{}/resize", self.proxy_url_term(server_url));
            let body = serde_json::json!({ "cols": cols, "rows": rows }).to_string();
            http.post("term_resize", &url, token, &body, 5);
        }
    }

    /// 输入/输出通道失效（SSE 断开）时：把在途输入回填重试（不丢字符），
    /// 并清空在途标记（重连后 flush 继续）。
    /// 返回回填字节数（app 侧记 UI 日志）。
    pub fn term_link_lost(&mut self) -> usize {
        let mut requeued = 0;
        if self.input_in_flight {
            self.input_in_flight = false;
            let lost = std::mem::take(&mut self.last_input);
            if !lost.is_empty() {
                requeued = lost.len();
                if let Some(t) = self.term.as_mut() {
                    let mut retry = lost;
                    retry.extend_from_slice(&t.input_pending);
                    t.input_pending = retry;
                }
            }
        }
        self.last_input.clear();
        self.last_resize = None;
        requeued
    }

    /// 请求 sysinfo 快照（只读，无需审批）
    pub fn request_sysinfo(&mut self, http: &HttpClient, server_url: &str, token: &str) {
        self.sysinfo_loading = true;
        self.sysinfo_error.clear();
        let tag = format!("sysinfo:{}", self.name);
        http.mcp_call(tag, &self.proxy_url(server_url), token, "sysinfo", &serde_json::json!({}));
    }

    /// 切换 shell 类型（cmd ↔ PowerShell）：term 服务重建会话
    pub fn switch_shell(&mut self, http: &HttpClient, server_url: &str, token: &str, shell: &str) {
        // 切换在途：忽略重复点击（避免多个 POST 堆积 + 系统 ConPTY 压力）
        if self.pending_shell.is_some() {
            return;
        }
        if self.shell_kind == shell {
            return;
        }
        // 先改本地显示；响应成功才重置终端重连，失败回滚
        self.shell_kind = shell.to_string();
        self.pending_shell = Some(shell.to_string());
        let tag = format!("term_shell:{}", self.name);
        // proxy_url_term 已含 /term——拼接 /shell（勿重复写 /term）
        let url = format!("{}/shell", self.proxy_url_term(server_url));
        crate::logs::file_log("INFO", &format!("切换 shell 请求: {} → {}", self.name, url));
        http.post(
            tag,
            &url,
            token,
            &serde_json::json!({ "shell": shell }).to_string(),
            15,
        );
    }

    // -----------------------------------------------------------------------
    // 目录树（懒加载）
    // -----------------------------------------------------------------------

    fn find_tree_mut<'a>(roots: &'a mut [TreeDir], path: &str) -> Option<&'a mut TreeDir> {
        for r in roots {
            if r.path == path {
                return Some(r);
            }
            if let Some(children) = &mut r.children {
                if let Some(found) = Self::find_tree_mut(children, path) {
                    return Some(found);
                }
            }
        }
        None
    }

    /// 首次进入终端页：按平台建树根，**默认折叠**（点 ▶ 才懒加载展开）。
    /// win32 → 盘符列表；linux/android → 单根 "/"。
    pub fn load_root(&mut self) {
        if !self.tree_roots.is_empty() {
            return;
        }
        if self.platform == "win32" && !self.drives.is_empty() {
            let drives = self.drives.clone();
            for d in drives {
                self.tree_roots.push(TreeDir {
                    name: d.clone(),
                    path: d,
                    expanded: false,
                    loading: false,
                    error: String::new(),
                    children: None,
                });
            }
        } else {
            self.tree_roots.push(TreeDir {
                name: "/".into(),
                path: "/".into(),
                expanded: false,
                loading: false,
                error: String::new(),
                children: None,
            });
        }
    }

    /// 展开/折叠节点；展开且未加载时发起 file_list（懒加载）
    pub fn toggle_tree(&mut self, http: &HttpClient, server_url: &str, token: &str, path: &str) {
        let Some(node) = Self::find_tree_mut(&mut self.tree_roots, path) else { return };
        node.expanded = !node.expanded;
        if node.expanded && node.children.is_none() && !node.loading {
            node.loading = true;
            node.error.clear();
            let tag = format!("tree:{}:{}", self.name, path);
            http.mcp_call(
                tag,
                &self.proxy_url(server_url),
                token,
                "file_list",
                &serde_json::json!({ "path": path, "recursive": false }),
            );
        }
    }

    // -----------------------------------------------------------------------
    // 目录树展开（pending_expand 状态机，每层加载完成后由 UI 帧驱动继续）
    // -----------------------------------------------------------------------

    /// 沿 pending_expand 路径推进一层：目标在树中 → 展开（必要时加载）；
    /// 不在 → 展开其最深已加载前缀（加载完成后继续）。失败/无法推进 → 清空。
    pub fn expand_step(&mut self, http: &HttpClient, server_url: &str, token: &str) {
        let Some(target) = self.pending_expand.clone() else { return };
        // 目标在树中
        if let Some(node) = Self::find_tree_mut(&mut self.tree_roots, &target) {
            node.expanded = true;
            if node.children.is_none() {
                if node.loading {
                    return; // 加载中：等回调后 UI 帧再推进
                }
                node.loading = true;
                let tag = format!("tree:{}:{}", self.name, target);
                http.mcp_call(
                    tag,
                    &self.proxy_url(server_url),
                    token,
                    "file_list",
                    &serde_json::json!({ "path": target, "recursive": false }),
                );
            } else {
                self.pending_expand = None; // 已展开（内容可见）
            }
            return;
        }
        // 目标不在树中：找最深已加载前缀展开（加载完成后树里会出现目标段）
        let mut remaining: Option<String> = None;
        // 从根开始逐段匹配
        let mut current = String::new();
        for seg in Self::path_segments(&target) {
            let candidate = if current.is_empty() {
                seg.clone()
            } else {
                Self::join_path(&current, &seg)
            };
            if Self::find_tree_mut(&mut self.tree_roots, &candidate).is_some() {
                current = candidate;
            } else {
                remaining = Some(candidate);
                break;
            }
        }
        if let Some(p) = remaining {
            if let Some(node) = Self::find_tree_mut(&mut self.tree_roots, &p) {
                node.expanded = true;
                if node.children.is_none() {
                    if node.loading {
                        return; // 加载中：等回调后继续
                    }
                    node.loading = true;
                    let tag = format!("tree:{}:{}", self.name, p);
                    http.mcp_call(
                        tag,
                        &self.proxy_url(server_url),
                        token,
                        "file_list",
                        &serde_json::json!({ "path": p, "recursive": false }),
                    );
                    return; // 回调后 UI 帧再驱动 expand_step
                }
                // 前缀已加载但目标段不存在（目录不存在/权限）→ 放弃
            }
            self.pending_expand = None;
        } else if !current.is_empty() && current != target {
            // 目标即树中已存在的最深前缀（如 cd E:/ → 树节点 E:）：展开加载它
            if let Some(node) = Self::find_tree_mut(&mut self.tree_roots, &current) {
                node.expanded = true;
                if node.children.is_none() && !node.loading {
                    node.loading = true;
                    let tag = format!("tree:{}:{}", self.name, current);
                    http.mcp_call(
                        tag,
                        &self.proxy_url(server_url),
                        token,
                        "file_list",
                        &serde_json::json!({ "path": current, "recursive": false }),
                    );
                    return;
                }
            }
            self.pending_expand = None;
        } else {
            // 没有任何已加载前缀（树还没初始化）→ 放弃（等树就绪后手动展开）
            self.pending_expand = None;
        }
    }

    /// 路径段拆分（盘符/根 + 各目录段）与拼接
    fn path_segments(path: &str) -> Vec<String> {
        if path.starts_with('/') || path.starts_with('\\') {
            let mut segs = vec!["/".to_string()];
            for s in path.trim_start_matches(['/', '\\']).split(['/', '\\']).filter(|s| !s.is_empty()) {
                segs.push(s.to_string());
            }
            segs
        } else if path.len() >= 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes()[1] == b':' {
            let mut segs = vec![path[..2].to_string()];
            for s in path[2..].split(['/', '\\']).filter(|s| !s.is_empty()) {
                segs.push(s.to_string());
            }
            segs
        } else {
            path.split(['/', '\\']).filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()
        }
    }

    fn join_path(base: &str, seg: &str) -> String {
        if base == "/" {
            return format!("/{seg}");
        }
        let sep = if base.contains('\\') { "\\" } else { "/" };
        format!("{}{sep}{seg}", base.trim_end_matches(['/', '\\']))
    }

    /// file_list 结果分发（tag 里的 path 定位节点）
    pub fn apply_tree_result(&mut self, path: &str, body: &str) {
        let Some(node) = Self::find_tree_mut(&mut self.tree_roots, path) else { return };
        node.loading = false;
        let v: serde_json::Value = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(_) => {
                node.error = format!("解析失败: {body}");
                node.expanded = false;
                return;
            }
        };
        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
        if status != "ok" {
            node.error = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("加载失败")
                .to_string();
            node.expanded = false;
            // 失败中止 cd 导航（防死循环）
            self.pending_expand = None;
            return;
        }
        let entries = v.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let mut children = Vec::new();
        for e in entries {
            if e.get("type").and_then(|t| t.as_str()) != Some("directory") {
                continue;
            }
            let name = e.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let child_path = e.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
            children.push(TreeDir {
                name,
                path: child_path,
                expanded: false,
                loading: false,
                error: String::new(),
                children: None,
            });
        }
        children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        node.children = Some(children);
    }

    /// 树渲染（纯函数：只收集点击动作，不碰 self——避免渲染中可变借用冲突）。
    /// 交互：▶/▼ 展开 · 单击名称=浏览选中 · 右键=菜单（复制路径全平台；
    /// 设为工作目录仅 Android——Windows/Linux 在命令里 cd 即可）。
    /// ⚡ 仅在当前工作目录行显示（Android 的 cwd 标记）。
    pub fn render_tree(
        ui: &mut egui::Ui,
        nodes: &[TreeDir],
        depth: usize,
        browse: &str,
        cwd: &str,
        show_cwd: bool,
        actions: &mut Vec<TreeAction>,
    ) {
        let grey = egui::Color32::from_gray(150);
        let red = egui::Color32::from_rgb(229, 57, 53);
        let green = egui::Color32::from_rgb(12, 163, 12);
        for node in nodes {
            ui.horizontal(|ui| {
                ui.add_space(depth as f32 * 14.0);
                // ▶/▼（U+25B6/25BC）——egui 内置字体覆盖的播放符号；
                // ▸/▾（U+25B8/25BE）冷门几何符号会渲染异常（实测）
                let arrow = if node.expanded { "▼" } else { "▶" };
                if ui.selectable_label(false, arrow).clicked() {
                    actions.push(TreeAction::Toggle(node.path.clone()));
                }
                // 名称：浏览选中高亮；当前工作目录绿色
                let is_browse = browse == node.path;
                let is_cwd = show_cwd && cwd == node.path;
                let text = if is_cwd {
                    egui::RichText::new(&node.name).color(green)
                } else {
                    egui::RichText::new(&node.name)
                };
                let resp = ui.selectable_label(is_browse, text);
                if resp.clicked() {
                    actions.push(TreeAction::Browse(node.path.clone()));
                }
                // 右键菜单：复制路径（全平台）；设为工作目录（仅 Android）
                resp.context_menu(|ui| {
                    if show_cwd && ui.button("设为工作目录").clicked() {
                        actions.push(TreeAction::SetCwd(node.path.clone()));
                        ui.close_menu();
                    }
                    if ui.button("复制路径").clicked() {
                        actions.push(TreeAction::CopyPath(node.path.clone()));
                        ui.close_menu();
                    }
                });
                // ⚡ 标记：仅当前工作目录行显示（Android）
                if is_cwd {
                    ui.label(egui::RichText::new("⚡").size(11.0).color(green));
                }
                if node.loading {
                    ui.label(egui::RichText::new("…").color(grey));
                }
            });
            if node.expanded {
                if let Some(children) = &node.children {
                    Self::render_tree(ui, children, depth + 1, browse, cwd, show_cwd, actions);
                } else if node.loading {
                    ui.add_space(depth as f32 * 14.0 + 14.0);
                    ui.label(egui::RichText::new("加载中...").color(grey));
                } else if !node.error.is_empty() {
                    ui.add_space(depth as f32 * 14.0 + 14.0);
                    ui.colored_label(red, &node.error);
                }
            }
        }
    }

    /// MCP 结果分发（当前只用于 sysinfo——exec 已由真终端替代，无命令框）。
    /// body 为 MCP content 文本 = JSON 字符串。
    pub fn apply_mcp_result(&mut self, body: &str, err: &str) {
        if !err.is_empty() {
            self.sysinfo_loading = false;
            self.sysinfo_error = err.to_string();
            return;
        }
        // 解析返回 JSON
        let v: serde_json::Value = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(_) => {
                self.sysinfo_loading = false;
                self.sysinfo_error = format!("无法解析返回: {body}");
                return;
            }
        };
        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
        if status != "ok" {
            // error/blocked/confirmation_required 等——desktop 已无命令框，
            // 只可能来自 sysinfo 失败等，落错误区展示
            self.sysinfo_loading = false;
            self.sysinfo_error = v
                .get("error")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("reason").and_then(|x| x.as_str()))
                .unwrap_or(status)
                .to_string();
            return;
        }
        // sysinfo：格式化展示 + 捕获平台/盘符（目录树根策略依据）
        self.sysinfo_loading = false;
        self.sysinfo_error.clear();
        self.sysinfo = flatten_json(&v, "");
        self.platform = v
            .get("os")
            .and_then(|o| o.get("platform"))
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        self.drives = v
            .get("drives")
            .and_then(|d| d.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
    }

    /// 服务端 rename 结果（成功则更新本地名称；刷新设备列表由 app 侧触发）
    pub fn apply_rename(&mut self, ok: bool, err: &str) {
        self.rename_busy = false;
        if ok {
            let new_name = self.rename_input.trim().to_string();
            if !new_name.is_empty() {
                self.name = new_name;
            }
            self.error.clear();
        } else {
            self.error = format!("重命名失败: {err}");
        }
    }

    /// 撤销结果（成功由 app 侧关闭详情）
    pub fn apply_revoke(&mut self, ok: bool, err: &str) {
        if !ok {
            self.error = format!("撤销失败: {err}");
        }
    }
}

/// 简单 URL 路径段编码（零依赖；保留 ASCII 字母数字与 -_.~）
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// sysinfo JSON key → 中文显示名（未收录的 key 原样显示）
fn label_cn(key: &str) -> String {
    let map = [
        ("hostname", "主机名"),
        ("os", "系统"),
        ("platform", "平台"),
        ("type", "类型"),
        ("release", "版本"),
        ("arch", "架构"),
        ("uptimeHours", "运行时长(小时)"),
        ("cpu", "CPU"),
        ("model", "型号"),
        ("cores", "核心数"),
        ("speedMHz", "主频(MHz)"),
        ("loadAvg", "负载"),
        ("loadAvgNote", "说明"),
        ("memory", "内存"),
        ("totalMB", "总量(MB)"),
        ("freeMB", "空闲(MB)"),
        ("usedMB", "已用(MB)"),
        ("usedPercent", "使用率(%)"),
        ("disk", "磁盘"),
        ("path", "路径"),
        ("totalGB", "总量(GB)"),
        ("freeGB", "空闲(GB)"),
        ("network", "网络"),
        ("name", "名称"),
        ("address", "地址"),
        ("mac", "MAC"),
        ("collectedAt", "采集时间"),
        ("status", "状态"),
        ("device", "设备"),
    ];
    map.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string()).unwrap_or_else(|| key.to_string())
}

/// 把 sysinfo JSON 展平成 (label, value) 行（嵌套对象前缀 label）
fn flatten_json(v: &serde_json::Value, prefix: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                let label = if prefix.is_empty() {
                    label_cn(k)
                } else {
                    format!("{prefix}.{}", label_cn(k))
                };
                match val {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        out.extend(flatten_json(val, &label));
                    }
                    serde_json::Value::Null => out.push((label, "-".to_string())),
                    other => out.push((label, other.to_string())),
                }
            }
        }
        serde_json::Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                match item {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        out.extend(flatten_json(item, &format!("{prefix}[{i}]")));
                    }
                    other => out.push((format!("{prefix}[{i}]"), other.to_string())),
                }
            }
        }
        other => out.push((prefix.to_string(), other.to_string())),
    }
    out
}
