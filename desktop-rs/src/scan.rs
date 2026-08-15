//! 局域网 gca-server 嗅探：取本机 IP → 扫网段 18790 端口（并行）→ /health 验证。
//! 结果经 HttpClient channel 回 UI（tag: scan_result，body 为 JSON 数组）。

use crate::http::HttpClient;
use std::net::{TcpStream, UdpSocket};
use std::time::Duration;

/// gca-server 默认端口（可在常量处扩展多端口）
const PORTS: [u16; 1] = [18790];
const CONNECT_TIMEOUT_MS: u64 = 250;
const HEALTH_TIMEOUT_SECS: u64 = 2;

/// 后台线程执行扫描，结果异步回 UI。
/// mDNS 优先（INT-004：快、轻、不触发防火墙/杀软端口扫描告警）；
/// 无结果（无 mDNS 发布者等）→ 回退全网段端口扫描（现状保留）。
pub fn scan(http: &HttpClient) {
    let http = http.clone();
    std::thread::spawn(move || {
        let mut results = crate::mdns::discover(2000);
        if results.is_empty() {
            results = do_scan();
        }
        let body = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
        http.notify("scan_result", true, body);
    });
}

fn do_scan() -> Vec<String> {
    let prefixes = local_subnet_prefixes();
    let mut servers: Vec<String> = Vec::new();
    // 共享一个 client（/health 验证复用连接池，不必每次新建）
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(HEALTH_TIMEOUT_SECS))
        .build()
        .unwrap();

    for prefix in prefixes {
        for port in PORTS {
            // 并行探测网段内每个 IP 的端口
            let mut handles = Vec::new();
            for i in 1..=254 {
                let ip = format!("{prefix}.{i}");
                handles.push(std::thread::spawn(move || port_open(&ip, port)));
            }
            for (i, h) in handles.into_iter().enumerate() {
                if h.join().unwrap_or(false) {
                    let ip = format!("{prefix}.{}", i + 1);
                    // 端口开了还不够：/health 返回 ok 才认定是 gca-server
                    let url = format!("http://{ip}:{port}");
                    if health_ok(&client, &url) {
                        servers.push(url);
                    }
                }
            }
        }
    }
    servers
}

/// /health 探测（无鉴权）。gca-server 返回 {ok: true}，设备端返回 {status: "ok"}，
/// 两种都算通过。
fn health_ok(client: &reqwest::blocking::Client, url: &str) -> bool {
    let res = crate::http::http_get_blocking(client, &format!("{url}/health"), "", HEALTH_TIMEOUT_SECS, String::new());
    if !res.ok {
        return false;
    }
    let v: serde_json::Value = serde_json::from_str(&res.body).unwrap_or_default();
    v.get("status").and_then(|s| s.as_str()) == Some("ok")
        || v.get("ok").and_then(|o| o.as_bool()) == Some(true)
}

/// 本机所有非回环 IPv4 地址（去重）。枚举全部网卡（powershell Get-NetIPAddress）
/// ——UDP connect 技巧只能拿默认路由的 IP，本机常有多个网卡
/// （物理 + Hyper-V/WSL/VPN 虚拟），默认路由可能落在虚拟网段上。
/// 供端口扫描（/24 前缀）与 mDNS 钉组播接口（mdns.rs）共用。
pub fn local_ipv4s() -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();
    let out = no_window(&mut std::process::Command::new("powershell.exe"))
        .args(["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress"])
        .output();
    if let Ok(out) = out {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let ip = line.trim();
            // 跳过 APIPA（169.254）与回环
            if ip.starts_with("169.254.") || ip.starts_with("127.") || !ip.contains('.') {
                continue;
            }
            if !ips.iter().any(|x| x == ip) {
                ips.push(ip.to_string());
            }
        }
    }
    // 兜底：默认路由网段 IP（UDP 技巧，仅当枚举失败时）
    if ips.is_empty() {
        if let Some(p) = default_route_prefix() {
            ips.push(format!("{p}.1"));
        }
    }
    ips
}

/// 本机所有网卡的 /24 前缀（去重）
fn local_subnet_prefixes() -> Vec<String> {
    let mut prefixes: Vec<String> = Vec::new();
    for ip in local_ipv4s() {
        if let Some(prefix) = ip.rsplitn(2, '.').nth(1) {
            if !prefixes.iter().any(|p| p == prefix) {
                prefixes.push(prefix.to_string());
            }
        }
    }
    prefixes
}

/// UDP connect 技巧拿默认路由网段（兜底）
fn default_route_prefix() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip().to_string();
    ip.rsplitn(2, '.').nth(1).map(|p| p.to_string())
}

/// 无窗口子进程（防止 GUI 闪黑窗）
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

fn port_open(ip: &str, port: u16) -> bool {
    let addr = format!("{ip}:{port}");
    let Ok(a) = addr.parse() else { return false };
    TcpStream::connect_timeout(&a, Duration::from_millis(CONNECT_TIMEOUT_MS)).is_ok()
}
