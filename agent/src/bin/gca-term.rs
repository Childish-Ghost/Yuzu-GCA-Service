//! gca-term：人终端服务（被控设备）——免审批、常驻会话。
//! 端点：/term/exec /term/interrupt /term/shell /term/close /term/ls /term/sysinfo
//! 环境变量：GCA_TERM_TOKEN（独立 token）/ GCA_TERM_PORT(3011) / GCA_TERM_IDLE_MS(300000)
//!
//! Android 原生化（docs/android-native-plan.md）：ConPTY 为 Windows 硬依赖，
//! 本 bin 不随 APK——Android target 下编译为占位 main（JNI 只启动 agent lib）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

#[cfg(target_os = "windows")]
use gca_agent::term;
use gca_agent::http;

/// 进程启动时间（秒），/health uptime 用
static STARTED_AT: AtomicU64 = AtomicU64::new(0);

#[cfg(not(target_os = "windows"))]
fn main() {
    // Android 占位：真终端是 Windows 硬依赖（ConPTY），不随 APK（docs/android-native-plan.md）
}

#[cfg(target_os = "windows")]
fn main() {
    // 抑制子进程 loader 错误弹窗（ConPTY 拉起的 cmd/powershell 偶发 DLL
    // 初始化失败 0xc0000142 时不再弹「Application Error」——错误模式继承）
    gca_agent::conpty::suppress_child_error_dialogs();

    let port = std::env::var("GCA_TERM_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3011);
    // token：GCA_TERM_TOKEN 优先（独立配置——AI 通道泄露 ≠ 免审批终端）；
    // 未配置回退 GCA_MCP_TOKEN（默认同 token，gca-server 远程代理可直接转发）
    let token = std::env::var("GCA_TERM_TOKEN")
        .or_else(|_| std::env::var("GCA_MCP_TOKEN"))
        .unwrap_or_default();
    let device_name = std::env::var("GCA_DEVICE_NAME").unwrap_or_else(|_| "gca-term".to_string());
    // 空闲回收：无 SSE 连接 + 空闲超时 → 结束会话（GCA_TERM_IDLE_MS 默认 5 分钟）
    let idle_ms = std::env::var("GCA_TERM_IDLE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(300_000);
    term::spawn_idle_reaper(idle_ms);
    gca_agent::logging::migrate_old_logs();

    STARTED_AT.store(
        std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        Ordering::Relaxed,
    );
    println!("gca-term listening on 0.0.0.0:{port} (device: {device_name})");
    // C15：开放模式显眼警告（无 token 时 /term/* 对网络开放，仅限开发）
    if token.is_empty() {
        println!("  ⚠ WARNING: no GCA_TERM_TOKEN/GCA_MCP_TOKEN configured — /term is OPEN to the network (dev only!)");
    }

    let handler = move |req: http::Request| -> http::Response {
        // GET /health：探活（Bearer 校验宽松）
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
                    "service": "gca-term",
                    "uptime": uptime,
                    "shell": term::current_shell(),
                }),
            );
        }
        term::handle(&req, &token)
    };

    if let Err(e) = http::serve(port, std::sync::Arc::new(handler)) {
        eprintln!("HTTP server error: {e}");
        std::process::exit(1);
    }
}
