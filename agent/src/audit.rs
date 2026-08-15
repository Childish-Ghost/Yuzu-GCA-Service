//! 审计集中推送（INT-005）：操作日志 → gca-server /audit。
//!
//! 可选开关 `GCA_AUDIT_PUSH=1`（默认关——本地留痕为默认，文档见 docs/backlog.md INT-005）；
//! 目标 `GCA_SERVER_URL/audit`（desktop 拉起 agent 时注入，见 localmcp.rs）；
//! Bearer 优先 `GCA_DEVICE_TOKEN`（S1 设备 token 隔离，2026-08-12），回退 `GCA_MCP_TOKEN`（过渡）。
//! 零依赖：std TCP 手写 HTTP POST。尽力而为：失败静默（审计不阻塞业务、不重试）。
//! 挂钩点（审批/执行/传输三类，对齐 backlog）：
//!   - pending::pop_latest        → approval_granted（所有确认操作，detail 含命令/路径）
//!   - tools::exec::run readonly  → exec（免审批执行）
//!   - tools::exec::run dangerous → exec_blocked（被拦截命令，安全事件）
//!   - tools::file_transfer 票据直下 → file_fetch（免确认传输，票据即授权）

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DETAIL_MAX: usize = 500;
const TIMEOUT_MS: u64 = 3000;

/// 推送一条审计（非阻塞：新线程发送，忽略一切错误）。
pub fn push(action: &str, detail: &str, status: &str) {
    if !std::env::var("GCA_AUDIT_PUSH").map(|v| v == "1").unwrap_or(false) {
        return; // 默认本地留痕，不推送
    }
    let server = std::env::var("GCA_SERVER_URL").unwrap_or_default();
    if server.trim().is_empty() {
        return; // 未配置服务器地址（独立运行模式）——本地留痕
    }
    // S1：设备自铸 token 优先（服务端 /audit 按设备 token 认证）；回退 MCP token（过渡期）
    let token = std::env::var("GCA_DEVICE_TOKEN")
        .unwrap_or_else(|_| std::env::var("GCA_MCP_TOKEN").unwrap_or_default());
    let device = std::env::var("GCA_DEVICE_NAME")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_| "gca-device".into()));
    let (action, detail, status) = (action.to_string(), truncate(detail, DETAIL_MAX), status.to_string());
    let server = server.trim_end_matches('/').to_string();
    std::thread::spawn(move || {
        if let Err(e) = send(&server, &token, &device, &action, &detail, &status) {
            eprintln!("[audit] push failed: {e}");
        }
    });
}

/// 零依赖 HTTP POST（仅 http://；失败即 Err，调用方忽略）
fn send(server: &str, token: &str, device: &str, action: &str, detail: &str, status: &str) -> Result<(), String> {
    let (host, port) = parse_url(server)?;
    let addr = format!("{host}:{port}")
        .parse::<std::net::SocketAddr>()
        .map_err(|e| format!("bad address {host}:{port}: {e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("connect failed: {e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_millis(TIMEOUT_MS)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(TIMEOUT_MS)));

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let body = serde_json::json!({
        "deviceId": device,
        "action": action,
        "detail": detail,
        "status": status,
        "ts": ts,
    })
    .to_string();

    let host_header = if port == 80 { host.to_string() } else { format!("{host}:{port}") };
    let mut req = format!(
        "POST /audit HTTP/1.1\r\nHost: {host_header}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len(),
    );
    if !token.is_empty() {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(&body);

    stream.write_all(req.as_bytes()).map_err(|e| format!("send failed: {e}"))?;
    // 读响应头（审计不关心内容，读完即断）
    let mut buf = [0u8; 512];
    let _ = stream.read(&mut buf);
    Ok(())
}

/// `http://host[:port]` → (host, port)。仅支持 http；畸形输入返回 Err。
fn parse_url(server: &str) -> Result<(String, u16), String> {
    let rest = server
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// supported: {server}"))?;
    let host_port = rest.split('/').next().unwrap_or(rest);
    if host_port.is_empty() {
        return Err("empty host".into());
    }
    match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            Ok((h.to_string(), p.parse().unwrap_or(80)))
        }
        _ => Ok((host_port.to_string(), 80)),
    }
}

/// 按字符截断（不劈开 UTF-8 序列）
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut out = String::new();
    let mut len = 0;
    for c in s.chars() {
        len += c.len_utf8();
        if len > max {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_basic() {
        assert_eq!(parse_url("http://<网关IP>:18790").unwrap(), ("<网关IP>".into(), 18790));
        assert_eq!(parse_url("http://<网关IP>").unwrap(), ("<网关IP>".into(), 80));
        assert_eq!(parse_url("http://host.local:8080/").unwrap(), ("host.local".into(), 8080));
        assert!(parse_url("https://x:1").is_err());
        assert!(parse_url("garbage").is_err());
    }

    #[test]
    fn truncate_keeps_utf8() {
        let s = "中文命令".repeat(100); // 600 字符
        let t = truncate(&s, 100);
        assert!(t.len() <= 100 + 3); // 截断 + 省略号
        assert!(!t.contains('\u{FFFD}'));
        assert!(t.ends_with('…'));
    }

    #[test]
    fn short_string_untouched() {
        assert_eq!(truncate("hello", 500), "hello");
    }

    /// 实网验证（需本地 gca-server 在跑；CI 不跑）：
    /// GCA_AUDIT_PUSH=1 + GCA_SERVER_URL → push 后服务端 /audit 可查到
    #[test]
    #[ignore]
    fn live_push_to_server() {
        std::env::set_var("GCA_AUDIT_PUSH", "1");
        std::env::set_var("GCA_SERVER_URL", "http://127.0.0.1:18791");
        std::env::set_var("GCA_MCP_TOKEN", "testtoken");
        std::env::set_var("GCA_DEVICE_NAME", "audit-live-test");
        push("exec", "echo live-test", "executed");
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}
