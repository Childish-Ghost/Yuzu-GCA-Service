//! agent 服务器入口——gca-agent bin 与 Android JNI 桥共用（docs/android-native-plan.md P1）。
//! 端点：/health /mcp /transfer/{token}（规范见 docs/architecture.md）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::{config, http, mcp, tickets};

/// 进程启动时间（秒），/health uptime 用
static STARTED_AT: AtomicU64 = AtomicU64::new(0);

/// 构造 MCP agent 的 HTTP handler（/health 探活 /mcp JSON-RPC /transfer 一次性票据）
pub fn make_handler(
    token: String,
    device_name: String,
) -> impl Fn(http::Request) -> http::Response + Send + Sync + 'static {
    move |req: http::Request| -> http::Response {
        // GET /health：探活（Bearer 校验宽松——health 放行，与 node 版一致）
        if req.method == "GET" && req.path == "/health" {
            let uptime = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .saturating_sub(STARTED_AT.load(Ordering::Relaxed));
            return http::Response::json(
                200,
                serde_json::json!({
                    "status": "ok",
                    "device": device_name,
                    "activeSessions": 0,
                    "uptime": uptime,
                }),
            );
        }

        // GET /transfer/{token}：一次性票据下载（数据面，票据本身即授权——
        // 与 node 版一致，不做 Bearer 校验；单次使用 + 5 分钟 TTL 已限制暴露面）
        if req.method == "GET" && req.path.starts_with("/transfer/") {
            let token = &req.path["/transfer/".len()..];
            return match tickets::consume(token) {
                Some(t) => http::Response::file(std::path::PathBuf::from(t.path), t.size),
                None => http::Response::json(
                    404,
                    serde_json::json!({ "error": "Invalid or expired transfer token" }),
                ),
            };
        }

        // POST /mcp：MCP JSON-RPC（需 Bearer 配对 token）
        if req.method == "POST" && req.path == "/mcp" {
            if !token.is_empty() && !mcp::authed(&req, &token) {
                return http::Response::json(
                    401,
                    serde_json::json!({ "error": "Unauthorized: valid Bearer token required" }),
                );
            }
            return mcp::handle(&req);
        }

        http::Response::not_found()
    }
}

/// 启动 agent HTTP 服务（阻塞）。Android JNI 与 gca-agent bin 共用入口。
pub fn serve(cfg: &config::Config) -> Result<(), String> {
    STARTED_AT.store(
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        Ordering::Relaxed,
    );

    crate::logging::migrate_old_logs();
    // Android 上 stdout 不进 logcat——横幅走 logging（cfg(android) 转 logcat）
    crate::logging::log("info", &format!("gca-agent listening on 0.0.0.0:{} (device: {})", cfg.port, cfg.device_name));
    // C15：开放模式显眼警告（与 node 版 logPairingState 对齐——无 token 时 /mcp 对网络开放，仅限开发）
    if cfg.token.is_empty() {
        crate::logging::log("info", "⚠ WARNING: no GCA_MCP_TOKEN configured — /mcp is OPEN to the network (dev only!)");
    }

    let handler = make_handler(cfg.token.clone(), cfg.device_name.clone());
    start_heartbeat(cfg);
    http::serve(cfg.port, std::sync::Arc::new(handler)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 心跳（P3 Android 原生化）：登录立即 + 每 5 分钟 POST {GCA_SERVER_URL}/heartbeat，
// 设备 token 认证，携带 machineId/deviceName/port——server 按 machineId 定位设备并
// 更新 URL（DHCP 变动自愈；与 desktop 心跳对齐，见 GCA-MASTER 决策 9）。
// 零依赖：std TCP 手写 HTTP POST（复用 audit.rs 同款模式）。
// ---------------------------------------------------------------------------

/// 启动心跳线程（未配置 GCA_SERVER_URL 时静默跳过——独立运行模式）
pub fn start_heartbeat(cfg: &config::Config) {
    let server = std::env::var("GCA_SERVER_URL").unwrap_or_default();
    if server.trim().is_empty() {
        return;
    }
    // S1：设备自铸 token 优先（/heartbeat 按设备 token 认证），回退 MCP token
    let token = std::env::var("GCA_DEVICE_TOKEN").unwrap_or_else(|_| cfg.token.clone());
    let (name, machine_id, port) = (cfg.device_name.clone(), cfg.machine_id.clone(), cfg.port);
    std::thread::spawn(move || {
        loop {
            if let Err(e) = heartbeat_once(&server, &token, &name, &machine_id, port) {
                crate::logging::log("error", &format!("heartbeat failed: {e}"));
            }
            std::thread::sleep(std::time::Duration::from_secs(300)); // 5 分钟
        }
    });
}

/// 单次心跳 POST
fn heartbeat_once(server: &str, token: &str, device_name: &str, machine_id: &str, port: u16) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let server = server.trim_end_matches('/');
    let host = server
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("ws://");
    let (host, port_part) = match host.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, p),
        _ => (host, "80"),
    };
    let addr = format!("{host}:{port_part}");
    let mut conn = TcpStream::connect(&addr)
        .map_err(|e| format!("connect {addr}: {e}"))?;
    conn.set_read_timeout(Some(std::time::Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "machineId": machine_id,
        "port": port,
        "deviceName": device_name,
    })
    .to_string();

    let req = format!(
        "POST /heartbeat HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        token,
        body
    );
    conn.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut resp = Vec::new();
    conn.read_to_end(&mut resp).map_err(|e| e.to_string())?;
    let head = String::from_utf8_lossy(&resp);
    if !head.starts_with("HTTP/1.1 200") {
        return Err(format!("server responded: {}", head.lines().next().unwrap_or("?")));
    }
    Ok(())
}
