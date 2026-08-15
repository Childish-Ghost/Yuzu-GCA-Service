//! 终端服务分发（gca-term bin 用）：/term/* REST 端点——人终端专用，免审批。
//! 真终端模型（C-1：portable-pty ConPTY + SSE 流式）：
//!   GET  /term/sse       SSE 长连接：data: <base64 输出块>（心跳 : p）
//!   POST /term/input     {data: <base64 键盘字节>} → ConPTY 输入
//!   POST /term/resize    {cols, rows} → 调整字符网格
//!   POST /term/shell     {shell: cmd|powershell} → 重建会话
//!   POST /term/ls | /term/sysinfo  保留（目录树/初始化）
//! 旧命令级 RPC（exec/interrupt/close）废弃 404——结构化通道归 gca-agent。
//! 审计：会话级事件（免审批 ≠ 无痕）。

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::conpty;
use crate::http;
use crate::mcp;
use crate::tools;

/// 全局 ConPTY 会话（懒启动；空闲回收由 spawn_idle_reaper 负责）
static SESSION: Mutex<Option<Arc<conpty::Session>>> = Mutex::new(None);
/// 当前 shell 配置（会话重建用）
static SHELL: Mutex<String> = Mutex::new(String::new());
/// 最近一次 resize/SSE 校准的网格尺寸——**切 shell 重建会话时沿用**：
/// 否则会话按默认 100x30 启动（PSReadLine/cmd 行号按 30 行初始化），
/// 之后 resize 到实际尺寸 → 行号偏移 → 光标定位错位（显示字符错乱/
/// 输入回显缩进 24/提示符不在底部）
static LAST_SIZE: Mutex<(u16, u16)> = Mutex::new((DEFAULT_COLS, DEFAULT_ROWS));

fn remember_size(cols: u16, rows: u16) {
    *LAST_SIZE.lock().unwrap() = (cols.max(20), rows.max(5));
}

/// 默认字符网格尺寸（SSE 连接时；桌面端随后 resize 校准）
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;

// ---------------------------------------------------------------------------
// 会话管理
// ---------------------------------------------------------------------------

/// 取会话；无则按当前 shell 懒启动（失败返回 None）。
/// cols/rows 仅在**首次创建**时生效（SSE 连接带尺寸 → shell 在正确网格下
/// 启动——避免 100x30 启动后 resize 导致 PSReadLine 行号与屏幕错位）。
/// 已存在的会话若已死（子进程 DLL 初始化失败 0xc0000142 秒退——ConPTY
/// 上下文间歇性出现）→ 回收换新，否则死会话会让重连挂空（无输出、无回显）。
fn get_or_spawn(cols: u16, rows: u16) -> Option<Arc<conpty::Session>> {
    let mut guard = SESSION.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        if s.alive() {
            return Some(s.clone());
        }
        // 死会话：回收（close 确保子进程退出）后按新会话继续
        crate::logging::log("session", "respawn dead session (child exited early)");
        audit_event("session_respawned", "dead child");
        guard.take();
    }
    let shell = {
        let mut sh = SHELL.lock().unwrap();
        if sh.is_empty() {
            *sh = "cmd".to_string(); // 首次：默认 cmd
        }
        sh.clone()
    };
    match conpty::Session::spawn(&shell, cols.max(20), rows.max(5)) {
        Ok(s) => {
            let s = Arc::new(s);
            crate::logging::log("session", &format!("opened shell={shell}"));
            audit_event("session_opened", &format!("shell={shell}"));
            *guard = Some(s.clone());
            Some(s)
        }
        Err(e) => {
            crate::logging::log("error", &format!("session open failed: {e}"));
            audit_event("session_open_failed", &e.to_string());
            None
        }
    }
}

/// 当前 shell 配置（desktop 连接时同步显示用）
pub fn current_shell() -> String {
    let sh = SHELL.lock().unwrap();
    if sh.is_empty() { "cmd".to_string() } else { sh.clone() }
}

/// 切换 shell：关闭旧会话，重建新会话（桌面端随后重连 SSE）
pub fn switch_shell(shell: &str) -> Result<(), String> {
    if shell != "cmd" && shell != "powershell" {
        return Err(format!("unsupported shell: {shell}"));
    }
    {
        let mut sh = SHELL.lock().unwrap();
        *sh = shell.to_string();
    }
    let old = SESSION.lock().unwrap().take();
    if let Some(s) = old {
        crate::logging::log("switch", &format!("close old (shell={})", s.shell));
        audit_event("session_closed", "shell_switch");
        s.close();
    }
    // 用最近一次 resize 的尺寸重建（shell 启动即在正确网格下——
    // 100x30 启动后 resize 会导致 PSReadLine/cmd 行号偏移）
    let (cols, rows) = *LAST_SIZE.lock().unwrap();
    // spawn 失败重试 1 次（系统 ConPTY 间歇失败：close 后立即创建可能撞上清理）
    let mut last = get_or_spawn(cols, rows);
    if last.is_none() {
        std::thread::sleep(std::time::Duration::from_millis(300));
        crate::logging::log("switch", "retry spawn after failure");
        last = get_or_spawn(cols, rows);
    }
    match last {
        Some(_) => {
            crate::logging::log("switch", &format!("to {shell}"));
            Ok(())
        }
        None => Err("failed to start session".into()),
    }
}

/// 空闲回收线程：无订阅者（终端页关闭）且空闲超过 idle_ms → 结束会话。
/// 有 SSE 连接时始终保留。
pub fn spawn_idle_reaper(idle_ms: u64) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let (sess, has_subs) = {
                let g = SESSION.lock().unwrap();
                (g.clone(), g.as_ref().map(|s| s.has_subscribers()).unwrap_or(false))
            };
            if let Some(s) = sess {
                if !has_subs && s.idle_ms() > idle_ms {
                    let mut g = SESSION.lock().unwrap();
                    if let Some(cur) = g.take() {
                        crate::logging::log("reclaim", &format!("idle {}ms > {}ms", s.idle_ms(), idle_ms));
                        audit_event("session_closed", "idle_reclaimed");
                        cur.close();
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// SSE 输出格式
// ---------------------------------------------------------------------------

/// base64 编码（零依赖手写；VT 转义序列含任意字节，SSE 事件用 base64 保真）

fn write_sse_event(stream: &mut std::net::TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    let b64 = crate::base64::encode(bytes);
    stream.write_all(format!("data: {b64}\r\n\r\n").as_bytes())
}

/// 解析 SSE query 里的尺寸（/term/sse?cols=120&rows=30）——无效/缺失回默认
fn parse_size_query(path: &str) -> (u16, u16) {
    let mut cols = DEFAULT_COLS;
    let mut rows = DEFAULT_ROWS;
    if let Some(q) = path.split_once('?') {
        for kv in q.1.split('&') {
            if let Some((k, v)) = kv.split_once('=') {
                let n = v.parse::<u16>().unwrap_or(0);
                match k {
                    "cols" if n > 0 => cols = n,
                    "rows" if n > 0 => rows = n,
                    _ => {}
                }
            }
        }
    }
    (cols, rows)
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/// /term/* 分发（Bearer 校验用 term 独立 token，由路由层传入）
pub fn handle(req: &http::Request, token: &str) -> http::Response {
    if !token.is_empty() && !mcp::authed(req, token) {
        return http::Response::json(
            401,
            serde_json::json!({ "error": "Unauthorized: valid Bearer token required" }),
        );
    }
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
    match (req.method.as_str(), req.path.as_str()) {
        // SSE 长连接：订阅会话输出流，逐块 base64 推送；心跳保活。
        // query 带 cols/rows（桌面端网格尺寸）→ 会话在正确尺寸下启动/
        // 校准——shell 启动即按实际网格渲染（PSReadLine 行号不偏移，
        // 避免 resize 竞态导致的提示符错位/缩进）
        ("GET", p) if p == "/term/sse" || p.starts_with("/term/sse?") => {
            let (cols, rows) = parse_size_query(p);
            let Some(sess) = get_or_spawn(cols, rows) else {
                return http::Response::json(500, serde_json::json!({ "error": "session start failed" }));
            };
            // 已有会话（非新启动）：校准到请求尺寸（幂等）
            sess.resize(cols.max(20), rows.max(5));
            remember_size(cols, rows);
            let (rx, sub) = sess.subscribe();
            crate::logging::log("conn", &format!("sse connect (shell={})", sess.shell));
            http::Response::sse(Box::new(move |stream| {
                use std::io::Read;
                // 断开检测：客户端 close（FIN）→ read 返回 0。write 失败不可靠
                // （TCP 半开：缓冲可能让 write 先成功），不读则静默会话的 hook
                // 永远不退出 → 死订阅者 → idle 回收永不触发。
                let _ = stream.set_read_timeout(Some(Duration::from_millis(30)));
                let mut last_ping = Instant::now();
                let mut result = Ok(());
                loop {
                    // 输出优先：先收输出（100ms 超时）——read 探测放后面，
                    // 否则探测阻塞 500ms 会让回显延迟（输入反馈慢）。
                    match rx.recv_timeout(Duration::from_millis(30)) {
                        Ok(bytes) if !bytes.is_empty() => {
                            if write_sse_event(stream, &bytes).is_err() {
                                result = Err(());
                                break;
                            }
                        }
                        Ok(_) => break, // 会话结束信号
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if last_ping.elapsed() >= Duration::from_secs(2) {
                                if stream.write_all(b": p\r\n\r\n").is_err() {
                                    result = Err(());
                                    break;
                                }
                                last_ping = Instant::now();
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    // 断开探测（100ms 超时）：FIN → 0 → 客户端已断开
                    let mut probe = [0u8; 1];
                    match stream.read(&mut probe) {
                        Ok(0) => break, // 客户端关闭
                        Ok(_) => {}     // 客户端发来数据（忽略，SSE 单向）
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => break,
                    }
                }
                // 连接退出：注销订阅——否则死订阅者使 idle 回收永不触发
                sess.unsubscribe(&sub);
                crate::logging::log("conn", "sse disconnect");
                let _ = result;
            }))
        }
        // 键盘输入（base64 字节保真）
        ("POST", "/term/input") => {
            let data = body.get("data").and_then(|d| d.as_str()).unwrap_or("");
            let bytes = crate::base64::decode(data);
            if bytes.is_empty() {
                return http::Response::json(400, serde_json::json!({ "error": "empty input" }));
            }
            match get_or_spawn(DEFAULT_COLS, DEFAULT_ROWS) {
                Some(sess) => match sess.write(&bytes) {
                    Ok(()) => http::Response::json(200, serde_json::json!({ "status": "ok" })),
                    Err(e) => http::Response::json(
                        500,
                        serde_json::json!({ "status": "error", "error": e.to_string() }),
                    ),
                },
                None => http::Response::json(500, serde_json::json!({ "error": "session start failed" })),
            }
        }
        // 调整伪终端尺寸（终端页窗口变化时）
        ("POST", "/term/resize") => {
            let cols = body.get("cols").and_then(|c| c.as_u64()).unwrap_or(DEFAULT_COLS as u64) as u16;
            let rows = body.get("rows").and_then(|r| r.as_u64()).unwrap_or(DEFAULT_ROWS as u64) as u16;
            remember_size(cols, rows);
            let (scols, srows) = *LAST_SIZE.lock().unwrap();
            match get_or_spawn(scols, srows) {
                Some(sess) => {
                    sess.resize(cols.max(20), rows.max(5));
                    http::Response::json(200, serde_json::json!({ "status": "ok", "cols": cols, "rows": rows }))
                }
                None => http::Response::json(500, serde_json::json!({ "error": "session start failed" })),
            }
        }
        // 切换 shell（重建 ConPTY 会话）
        ("POST", "/term/shell") => {
            let shell = body.get("shell").and_then(|s| s.as_str()).unwrap_or("cmd").to_string();
            match switch_shell(&shell) {
                Ok(()) => http::Response::json(200, serde_json::json!({ "status": "ok", "shell": shell })),
                Err(e) => http::Response::json(400, serde_json::json!({ "status": "error", "error": e })),
            }
        }
        // 目录列表（终端页树）
        ("POST", "/term/ls") => {
            let text = tools::file_ops::run_list(&body);
            wrap(text)
        }
        // 平台/盘符（终端页初始化）
        ("POST", "/term/sysinfo") => {
            let text = tools::sysinfo::run();
            wrap(text)
        }
        _ => http::Response::not_found(),
    }
}

// ---------------------------------------------------------------------------
// 审计（免审批 ≠ 无痕）：会话级事件写 %APPDATA%\GCA Desktop\term-audit.log
// ---------------------------------------------------------------------------

fn audit_event(action: &str, detail: &str) {
    let line = format!("{} | {} | {}\n", iso_now(), action, detail);
    let dir = crate::logging::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("term-audit.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
    // 滚动（审计也限 2MB）
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            crate::logging::rollover_public(&path, "term-audit");
        }
    }
}

/// 本地时间戳（YYYY-MM-DD HH:MM:SS，UTC——日志精确到事件本身即可）
fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth0 = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth0 > 12 { y + 1 } else { y };
    let mth = if mth0 > 12 { mth0 - 12 } else { mth0 };
    format!("{y:04}-{mth:02}-{d:02} {h:02}:{m:02}:{s:02}Z")
}

/// 工具结果 → MCP content 形态响应
fn wrap(r: Result<serde_json::Value, String>) -> http::Response {
    match r {
        Ok(v) => {
            let is_error = v.get("status").and_then(|s| s.as_str()) == Some("error");
            let mut result = serde_json::json!({
                "result": { "content": [{ "type": "text", "text": serde_json::to_string(&v).unwrap_or_default() }] }
            });
            if is_error {
                result["result"]["isError"] = serde_json::json!(true);
            }
            http::Response::json(200, result)
        }
        Err(e) => http::Response::json(
            200,
            serde_json::json!({
                "error": { "code": -32602, "message": e }
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for data in [
            b"hello world".as_slice(),
            b"\x1b[31mred\x1b[0m".as_slice(),
            b"\x00\x01\xfe\xff\x80".as_slice(),
            &[],
        ] {
            assert_eq!(crate::base64::decode(&crate::base64::encode(data)), data);
        }
    }

    #[test]
    fn base64_padding_ignored() {
        assert_eq!(crate::base64::decode("aGVsbG8="), b"hello");
        assert_eq!(crate::base64::decode("aGVsbG8=\r\n"), b"hello");
    }

    #[test]
    fn iso_now_format() {
        let s = iso_now();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20"));
        assert!(s.ends_with('Z'));
    }
}
