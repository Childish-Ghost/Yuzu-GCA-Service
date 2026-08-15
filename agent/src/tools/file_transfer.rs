//! file_serve / file_fetch：跨设备文件传输（C-007 数据面，与 node 版协议兼容）。
//!   serve：确认后铸一次性票据（单次使用、5 分钟 TTL），URL
//!          http://<本机局域网IP>:<port>/transfer/<token>——字节流设备间直连，控制面只见 URL
//!   fetch：票据 URL 直接下载（票据即授权——源头确认过，一次确认不是两次）；
//!          外部 http:// URL 需确认（任意写盘）。

use std::fs;
use std::path::PathBuf;

use crate::http;
use crate::pending::{self, PendingOp};
use crate::tickets;
use super::ToolDef;

const MAX_SERVE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2GB 上限（与 node 一致）

pub fn def_serve() -> ToolDef {
    ToolDef {
        name: "file_serve",
        description: "Publish a local file for a single one-shot download by another device (5-min ticket). Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" }
            },
            "required": ["path"]
        }),
    }
}

pub fn def_fetch() -> ToolDef {
    ToolDef {
        name: "file_fetch",
        description: "Download a file to this device. Transfer-ticket URLs execute immediately (the ticket IS the authorization); other http:// URLs require confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string" },
                "targetPath": { "type": "string" }
            },
            "required": ["url", "targetPath"]
        }),
    }
}

/// 相对路径 → 绝对路径（相对 agent 工作目录）
fn abs_path(p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        pb
    } else {
        std::env::current_dir().unwrap_or_default().join(pb)
    }
}

// ---------------------------------------------------------------------------
// file_serve
// ---------------------------------------------------------------------------

pub fn run_serve(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "path required".to_string())?;
    let abs = abs_path(path);
    let display = abs.to_string_lossy().to_string();

    let meta = fs::metadata(&abs).map_err(|_| format!("Path does not exist or is not accessible: {display}"))?;
    if !meta.is_file() {
        return Err(format!("Path is not a regular file: {display}"));
    }
    let size = meta.len();
    if size > MAX_SERVE_BYTES {
        return Err(format!("File too large ({size} bytes, cap is {MAX_SERVE_BYTES})"));
    }

    let token = pending::push(PendingOp::FileServe { path: display.clone() });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": "file_serve",
        "reason": format!("Publish {display} ({size} bytes) for a single one-shot download by another device (ticket expires in 5 minutes). Nothing is exposed yet."),
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }))
}

pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    match op {
        PendingOp::FileServe { path } => {
            let meta = match fs::metadata(path) {
                Ok(m) => m,
                Err(e) => return serde_json::json!({ "status": "error", "path": path, "error": e.to_string() }),
            };
            match tickets::mint(path.clone(), meta.len()) {
                Ok(token) => serde_json::json!({
                    "status": "serving",
                    "path": path,
                    "size": meta.len(),
                    "url": format!("{}/transfer/{token}", base_url()),
                    "expiresInSec": 300,
                    "confirmedByUser": true,
                }),
                Err(e) => serde_json::json!({ "status": "error", "path": path, "error": e }),
            }
        }
        PendingOp::FileFetch { url, target_path } => match download(url, &PathBuf::from(target_path)) {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "status": "error", "url": url, "error": e }),
        },
        _ => serde_json::json!({ "status": "error", "error": "not a file_transfer op" }),
    }
}

/// 本机数据面基址：TRANSFER_HOST 覆盖（NAT/DDNS 场景）→ UDP connect 路由
/// 探测（只做路由查找不发包，得到真实局域网网卡 IP，与 node transfer-host 一致）
/// → 127.0.0.1 兜底
fn base_url() -> String {
    let host = std::env::var("TRANSFER_HOST")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| {
            use std::net::UdpSocket;
            if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
                if sock.connect("203.0.113.1:80").is_ok() {
                    if let Ok(addr) = sock.local_addr() {
                        let ip = addr.ip().to_string();
                        if !ip.is_empty() && !ip.starts_with("169.254.") {
                            return ip;
                        }
                    }
                }
            }
            "127.0.0.1".to_string()
        });
    format!("http://{host}:{}", crate::config::load().port)
}

// ---------------------------------------------------------------------------
// file_fetch
// ---------------------------------------------------------------------------

pub fn run_fetch(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let url = args
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "url required".to_string())?
        .to_string();
    let target = args
        .get("targetPath")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "targetPath required".to_string())?;

    // 基本 URL 卫生：仅 http://，禁 file:// 等（与 node 一致）
    if !url.to_lowercase().starts_with("http://") {
        return Err("Only http:// transfer URLs are supported".to_string());
    }
    let abs = abs_path(target);

    // 票据 URL 直接执行：票据即授权（源头已确认，一次确认不是两次）
    if is_ticket_url(&url) {
        let result = download(&url, &abs);
        match &result {
            Ok(v) => {
                let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("ok");
                crate::audit::push("file_fetch", &url, status); // 免确认传输（INT-005）
            }
            Err(_) => crate::audit::push("file_fetch", &url, "error"),
        }
        return result;
    }

    // 外部 URL：任意写盘 → 需确认
    let token = pending::push(PendingOp::FileFetch { url: url.clone(), target_path: abs.to_string_lossy().to_string() });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": "file_fetch",
        "reason": format!("Download a file from another device to {}. Nothing has been downloaded yet.", abs.to_string_lossy()),
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }))
}

/// 票据 URL 判定：^http://[\w.:-]+/transfer/[\w-]{20,}$（手写，零 regex 依赖）。
/// **host 必须为本机地址**（base_url 探测结果或 127.0.0.1）——纯形状匹配会让
/// 任意主机 `/transfer/<20+字符>` 免确认写盘（审批绕过，2026-08-11 审查）。
fn is_ticket_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let Some(slash) = rest.find('/') else { return false };
    let (host, path) = (&rest[..slash], &rest[slash..]);
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || ".:-".contains(c)) {
        return false;
    }
    // host 校验：本机基址（含端口）或 127.0.0.1（本机铸票场景）
    let base = base_url();
    let base_host = base.strip_prefix("http://").unwrap_or(&base);
    let host_ok = host == base_host
        || host == "127.0.0.1"
        || host.split(':').next() == Some(base_host.split(':').next().unwrap_or(""));
    if !host_ok {
        return false;
    }
    let Some(token) = path.strip_prefix("/transfer/") else { return false };
    token.len() >= 20 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 执行下载：GET → 校验大小 → 建目录 → 写盘
fn download(url: &str, target: &PathBuf) -> Result<serde_json::Value, String> {
    let outcome = http::get(url, 120_000, 512 * 1024 * 1024)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, &outcome.bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "status": "fetched",
        "url": url,
        "targetPath": target.to_string_lossy(),
        "bytes": outcome.bytes.len(),
        "sizeMatches": outcome.size_matches,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_url_detection() {
        // 合法：host = 本机基址（base_url，含端口）或 127.0.0.1 + /transfer/ + ≥20 位
        let base = base_url();
        let base_host = base.strip_prefix("http://").unwrap_or(&base);
        assert!(is_ticket_url(&format!("{}/transfer/M-7wsA0UhXi7aEl_a3bdw_lhfguif", base)));
        assert!(is_ticket_url(&format!("http://{}/transfer/abcdefghijklmnopqrstuvwxyz123456", base_host)));
        assert!(is_ticket_url("http://127.0.0.1/transfer/abcdefghijklmnopqrstuvwxyz123456"));
        // 非票据
        assert!(!is_ticket_url("https://<本机IP>/transfer/abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_ticket_url("http://<本机IP>/other/abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_ticket_url("http://<本机IP>/transfer/short"));
        assert!(!is_ticket_url("http://<本机IP>/transfer/abcdefghijklmnopqrstuvwxyz123456?x=1"));
        // host 校验：任意主机纯形状匹配不再放行（2026-08-11 审查修复）
        assert!(!is_ticket_url("http://evil.example.com/transfer/abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_ticket_url("file:///transfer/abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_ticket_url(""));
    }

    #[test]
    fn abs_path_resolves_relative() {
        // 相对路径 → 绝对（拼接 cwd）
        let abs = abs_path("Cargo.toml");
        assert!(abs.is_absolute());
        // 已绝对（盘符）→ 原样
        assert_eq!(abs_path("C:\\x\\y"), PathBuf::from("C:\\x\\y"));
        // Windows 上前导 / 不是绝对路径（无盘符）→ 拼 cwd 后绝对
        let abs2 = abs_path("/tmp/x");
        assert!(abs2.is_absolute());
    }

    #[test]
    fn serve_validation() {
        // 缺 path
        assert!(run_serve(&serde_json::json!({})).is_err());
        // 不存在文件 → Err
        let r = run_serve(&serde_json::json!({ "path": "Z:\\no\\such\\file.txt" }));
        assert!(r.is_err());
    }

    #[test]
    fn fetch_url_hygiene() {
        // 非 http:// 拒绝
        assert!(run_fetch(&serde_json::json!({
            "url": "file:///etc/passwd", "targetPath": "C:\\x"
        }))
        .is_err());
        assert!(run_fetch(&serde_json::json!({
            "url": "https://example.com", "targetPath": "C:\\x"
        }))
        .is_err());
        // 缺字段
        assert!(run_fetch(&serde_json::json!({ "url": "http://a" })).is_err());
    }
}
