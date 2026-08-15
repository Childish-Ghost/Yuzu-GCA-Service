//! 本机设备端 MCP 带起：登录成功后确保本机 3001 端口的 gca client 在运行。
//! 与 Tauri 版 start_gca 行为一致——DETACHED_PROCESS + CREATE_NO_WINDOW，
//! token/machineId 走 env（不硬编码），日志写 %APPDATA%/GCA Desktop/gca-poc.log。

use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::http::HttpClient;

/// 无窗口子进程（Windows: CREATE_NO_WINDOW，防止 GUI 里闪黑窗）
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// 本机设备名（C12 修复：与 node 版 config.ts 派生规则一致——此前硬编码
/// gca-win11，改名/换机后注册名漂移）
pub fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let clean: String = host
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("gca-{clean}")
}

/// 本机 SMBIOS UUID（与 gca-server 注册用的 machineId 一致）
pub fn machine_id() -> String {
    #[cfg(target_os = "windows")]
    {
        let out = no_window(Command::new("powershell.exe").args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
        ]))
        .output();
        if let Ok(out) = out {
            let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !id.is_empty()
                && id != "Not Specified"
                && id != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
            {
                return id;
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = std::fs::read_to_string("/sys/class/dmi/id/product_uuid") {
            let id = id.trim().to_string();
            if !id.is_empty() && id != "Not Specified" {
                return id;
            }
        }
    }
    String::new()
}

/// 本机部署了哪些组件（agent 3001 / term 3011）——登录页部署形态判断。
/// 存在即算（运行中或已安装未拉起），返回 ["agent"] / ["term"] 等。
pub fn local_components() -> Vec<String> {
    let mut v = Vec::new();
    if port_alive(3001) || find_agent().is_some() {
        v.push("agent".to_string());
    }
    if port_alive(3011) || find_term().is_some() {
        v.push("term".to_string());
    }
    v
}

/// 端口是否已有进程监听（TCP 连接试探，比 netstat 轻量）
fn port_alive(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}").parse().unwrap();
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok()
}

/// 本机 term 服务入口（gca-term.exe，独立部署可选）
fn find_term() -> Option<PathBuf> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for p in [
        repo.join("..").join("target").join("release").join("gca-term.exe"),
        repo.join("..").join("target").join("debug").join("gca-term.exe"),
    ] {
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 本会话 spawn 的设备进程 PID（C10 修复：退出只杀自己拉起的，不再按镜像名
/// taskkill /IM——同机同名进程会被误杀）
static SPAWNED_PIDS: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

/// 环境标记：spawn 时写入，供崩溃/重启后残留进程识别（只杀带标记者）
const SPAWN_MARKER: &str = "GCA_SPAWNED_BY";

fn record_spawn(child: std::process::Child) -> std::process::Child {
    SPAWNED_PIDS.lock().unwrap().push(child.id());
    child
}

/// 按 PID 杀进程（带标记的残留进程兜底清理）
fn kill_pids(pids: &[u32]) {
    for pid in pids {
        let _ = no_window(Command::new("taskkill.exe").args(["/F", "/PID", &pid.to_string()])).output();
    }
}

/// 清理带 GCA_SPAWNED_BY 标记的残留设备进程（上一会话桌面崩溃/重启遗留）——
/// 按标记识别，不按镜像名。
#[cfg(target_os = "windows")]
fn kill_marked_stale() {
    let out = no_window(Command::new("powershell.exe").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'GCA_SPAWNED_BY' -and ($_.Name -match 'gca-agent|gca-term|node') }).ProcessId",
    ]))
    .output();
    if let Ok(out) = out {
        let pids: Vec<u32> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect();
        kill_pids(&pids);
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_marked_stale() {}

/// 清理占用 3001 的残留 gca 进程。
/// 安全约束：只杀 cmdline 确认是本机 gca client（bundle/dist 特征）的进程，不乱杀。
fn cleanup_stale() {
    #[cfg(target_os = "windows")]
    {
        let out = no_window(Command::new("netstat.exe").args(["-ano"])).output();
        let Ok(out) = out else { return };
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains(":3001") || !line.contains("LISTENING") {
                continue;
            }
            let pid = line.split_whitespace().last().unwrap_or("").to_string();
            if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let info = no_window(Command::new("wmic.exe").args([
                "process",
                "where",
                &format!("ProcessId={pid}"),
                "get",
                "CommandLine",
            ]))
            .output();
            if let Ok(info) = info {
                let cmdline = String::from_utf8_lossy(&info.stdout);
                let is_gca = cmdline.contains("gca-bundle.cjs")
                    || cmdline.contains("client/dist/index.js")
                    || cmdline.contains("gca-mcp");
                if is_gca {
                    let _ = no_window(Command::new("taskkill.exe").args(["/F", "/PID", &pid])).output();
                }
            }
        }
    }
}

/// 本机 agent 入口（优先 Rust 版 gca-agent.exe，回退 node bundle）
enum AgentEntry {
    /// Rust 原生 agent（release/debug 构建）
    RustExe(PathBuf),
    /// node + bundle（旧实现）
    NodeBundle(PathBuf),
}

fn find_agent() -> Option<AgentEntry> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // 1. Rust agent（release 优先，debug 兜底）
    for p in [
        repo.join("..").join("target").join("release").join("gca-agent.exe"),
        repo.join("..").join("target").join("debug").join("gca-agent.exe"),
    ] {
        if p.exists() {
            return Some(AgentEntry::RustExe(p));
        }
    }
    // 2. node client/dist
    let dist = repo.join("..").join("client").join("dist").join("index.js");
    if dist.exists() {
        return Some(AgentEntry::NodeBundle(dist));
    }
    // 3. Tauri 打包资源
    let bundled = repo
        .join("..")
        .join("desktop")
        .join("src-tauri")
        .join("resources")
        .join("gca-bundle.cjs");
    if bundled.exists() {
        return Some(AgentEntry::NodeBundle(bundled));
    }
    None
}

/// 以独立进程启动本机 MCP（detached + 无窗口）。
/// S1（2026-08-12）：注入 GCA_DEVICE_TOKEN（设备自铸 token——心跳/审计用）+ GCA_SPAWNED_BY
/// 标记（退出清理只杀自己拉起的进程，C10）。
fn spawn_local_mcp(mcp_token: &str, device_token: &str, entry: &AgentEntry, server_url: Option<&str>) -> std::io::Result<std::process::Child> {
    let log_path = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("logs").join("gca-poc.log"))
        .unwrap_or_else(|_| PathBuf::from("gca-poc.log"));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::File::create(&log_path)?;

    let mut cmd = match entry {
        AgentEntry::RustExe(exe) => {
            let mut c = Command::new(exe);
            c.env("GCA_AGENT_PORT", "3001")
                .env("GCA_DEVICE_NAME", device_name());
            c
        }
        AgentEntry::NodeBundle(bundle) => {
            let mut c = Command::new("node");
            c.arg(bundle)
                .env("GCA_AUTO_REGISTER", "0")
                .env("GCA_CLIPBOARD_SYNC", "0");
            c
        }
    };
    cmd.stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .env("GCA_MCP_TOKEN", mcp_token)
        .env("GCA_DEVICE_TOKEN", device_token)
        .env(SPAWN_MARKER, std::process::id().to_string());
    if let Some(url) = server_url {
        cmd.env("GCA_SERVER_URL", url); // 审计推送/心跳目标（INT-005）
    }
    let mid = machine_id();
    if !mid.is_empty() {
        cmd.env("GCA_MACHINE_ID", &mid);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS(0x8) | CREATE_NO_WINDOW(0x08000000)
        cmd.creation_flags(0x08000008);
    }
    cmd.spawn().map(record_spawn)
}

/// 以独立进程启动本机 term 服务（3011；token 与 agent 同——默认回退配置，C9 记录在案）
fn spawn_local_term(mcp_token: &str, device_token: &str, exe: &PathBuf) -> std::io::Result<std::process::Child> {
    let log_path = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("logs").join("gca-term-run.log"))
        .unwrap_or_else(|_| PathBuf::from("gca-term-run.log"));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::File::create(&log_path)?;
    let mut cmd = Command::new(exe);
    cmd.env("GCA_TERM_PORT", "3011")
        .env("GCA_DEVICE_NAME", device_name())
        .env("GCA_TERM_TOKEN", mcp_token)
        .env("GCA_DEVICE_TOKEN", device_token)
        .env(SPAWN_MARKER, std::process::id().to_string())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file));
    let mid = machine_id();
    if !mid.is_empty() {
        cmd.env("GCA_MACHINE_ID", &mid);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000008); // DETACHED_PROCESS | CREATE_NO_WINDOW
    }
    cmd.spawn().map(record_spawn)
}

/// 向 gca-server 上报本机当前 IP（POST /heartbeat——设备 URL 更新）。
/// 解决 DHCP IP 变动后设备离线：agent 注册后不主动更新 IP，旧地址过期
/// → 代理连不上。gca-server 从请求来源 IP 取地址，端口固定 3001。
/// S1：设备自铸 token 认证（服务端按 machineId 定位后比对 deviceToken）。
pub fn heartbeat(http: &HttpClient, server_url: &str, _token: &str) {
    let mid = machine_id();
    if mid.is_empty() {
        return;
    }
    let Some(device_token) = crate::login::ensure_device_token() else { return };
    let url = format!("{}/heartbeat", server_url.trim_end_matches('/'));
    let body = serde_json::json!({ "machineId": mid, "port": 3001 }).to_string();
    http.post("heartbeat", &url, &device_token, &body, 5);
}

/// 退出桌面端时一并结束设备服务（agent 3001 + term 3011）。
/// 桌面端是用户唯一可见的 GCA 入口——退出即意味着不再使用，
/// 服务继续驻留会让用户无法管理（无图标无 UI）。下次打开桌面端
/// 由 localmcp 重新拉起。
/// C10 修复（2026-08-12 审查）：不再按镜像名 taskkill /IM——
/// 只杀本会话 spawn 的 PID + 带 GCA_SPAWNED_BY 标记的残留（崩溃恢复）。
pub fn kill_local_services() {
    let pids: Vec<u32> = SPAWNED_PIDS.lock().unwrap().drain(..).collect();
    kill_pids(&pids);
    kill_marked_stale();
}

/// 确保本机双进程在运行（agent 3001 + term 3011，均可独立缺失）；
/// 结果异步经 channel 回 UI（tag: localmcp）
/// `server_url`：登录的 gca-server 地址（Some 时注入 agent 环境——
/// 审计推送需要，INT-005；term 不消费，不注入）
/// `local_mode`：本机模式时 GCA_MCP_TOKEN 用登录 token（desktop 直连本机
/// agent /mcp 用同一凭据）；否则用设备自铸 token（与注册表/Gateway 一致）
pub fn ensure_running(http: &HttpClient, owner_token: String, server_url: Option<&str>, local_mode: bool) {
    let http = http.clone();
    let server_url = server_url.map(|s| s.to_string());
    std::thread::spawn(move || {
        let mut msgs: Vec<String> = Vec::new();
        // S1：设备自铸 token（持久化在 config.json）；本机模式回退登录 token
        let device_token = crate::login::ensure_device_token().unwrap_or_else(|| owner_token.clone());
        let mcp_token = if local_mode { owner_token.clone() } else { device_token.clone() };

        // 1. agent（AI 通道 3001）
        if port_alive(3001) {
            msgs.push("agent 已在运行 (3001)".to_string());
        } else {
            cleanup_stale();
            if let Some(entry) = find_agent() {
                match spawn_local_mcp(&mcp_token, &device_token, &entry, server_url.as_deref()) {
                    Ok(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        if port_alive(3001) {
                            msgs.push("agent 已启动 (3001)".to_string());
                        } else {
                            msgs.push("agent 启动失败（看 %APPDATA%/GCA Desktop/gca-poc.log）".to_string());
                        }
                    }
                    Err(e) => msgs.push(format!("agent 启动失败: {e}")),
                }
            } else {
                msgs.push("找不到 agent（未安装）".to_string());
            }
        }

        // 2. term（人终端 3011，独立组件——未部署则终端页不可用）
        if port_alive(3011) {
            msgs.push("term 已在运行 (3011)".to_string());
        } else if let Some(term) = find_term() {
            match spawn_local_term(&mcp_token, &device_token, &term) {
                Ok(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if port_alive(3011) {
                        msgs.push("term 已启动 (3011)".to_string());
                    } else {
                        msgs.push("term 启动失败（看 %APPDATA%/GCA Desktop/gca-poc.log）".to_string());
                    }
                }
                Err(e) => msgs.push(format!("term 启动失败: {e}")),
            }
        } else {
            msgs.push("term 未安装（终端页不可用）".to_string());
        }

        http.notify("localmcp", true, msgs.join("；"));
    });
}
