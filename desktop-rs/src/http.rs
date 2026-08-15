//! HTTP 封装：所有请求跑在后台线程，结果经 channel 回 UI 线程（不卡界面）。
//! 每个请求带 tag，UI 侧按 tag 分发到对应页面状态。

use std::sync::mpsc::Receiver;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpResult {
    pub tag: String,
    pub ok: bool,
    pub body: String,
    pub error: String,
}

/// 解包 MCP 响应：{result:{content:[{type:"text",text:"{json}"}]}} → 内层 JSON 文本；
/// 非 MCP 包装原样返回（term 服务/审计等直接 JSON 响应）。
pub fn unwrap_mcp_body(body: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return body.to_string(),
    };
    if let Some(text) = v
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
    {
        return text.to_string();
    }
    body.to_string()
}

/// 后台 HTTP 客户端（可 Clone，线程安全）。
/// 共享一个 reqwest client（连接池复用——10ms 频次的终端输入 POST 不用每次新建
/// 连接池 + TCP 握手）；每个请求单独覆盖 timeout。
#[derive(Clone)]
pub struct HttpClient {
    tx: std::sync::mpsc::Sender<HttpResult>,
    rx: std::sync::Arc<std::sync::Mutex<Receiver<HttpResult>>>,
    client: reqwest::blocking::Client,
}

impl HttpClient {
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<HttpResult>();
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2)) // 局域网内足够；离线设备探测不等 8s
            .timeout(Duration::from_secs(15)) // 默认；每请求可覆盖
            .build()
            .unwrap();
        Self { tx, rx: std::sync::Arc::new(std::sync::Mutex::new(rx)), client }
    }

    /// 拉取一条完成的通知（UI 轮询，无则 None）
    pub fn poll(&self) -> Option<HttpResult> {
        self.rx.lock().unwrap().try_recv().ok()
    }

    /// 直接把一条结果送进 channel（给非 HTTP 的后台任务用，如本机 MCP 带起）
    pub fn notify(&self, tag: impl Into<String>, ok: bool, body: String) {
        let _ = self.tx.send(HttpResult { tag: tag.into(), ok, body, error: String::new() });
    }

    pub fn get(&self, tag: impl Into<String>, url: &str, token: &str, timeout_secs: u64) {
        let tx = self.tx.clone();
        let client = self.client.clone();
        let tag = tag.into();
        let url = url.to_string();
        let token = token.to_string();
        std::thread::spawn(move || {
            let result = http_get_blocking(&client, &url, &token, timeout_secs, tag);
            let _ = tx.send(result);
        });
    }

    pub fn post(&self, tag: impl Into<String>, url: &str, token: &str, body: &str, timeout_secs: u64) {
        let tx = self.tx.clone();
        let client = self.client.clone();
        let tag = tag.into();
        let url = url.to_string();
        let token = token.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            let result = http_post_blocking(&client, &url, &token, &body, timeout_secs, tag);
            let _ = tx.send(result);
        });
    }

    /// MCP 调用（initialize + tools/call，带回 session-id）
    pub fn mcp_call(&self, tag: impl Into<String>, url: &str, token: &str, tool: &str, args: &serde_json::Value) {
        let tx = self.tx.clone();
        let client = self.client.clone();
        let tag = tag.into();
        let url = url.to_string();
        let token = token.to_string();
        let tool = tool.to_string();
        let args = args.clone();
        std::thread::spawn(move || {
            let result = mcp_call_blocking(&client, &url, &token, &tool, &args, tag);
            let _ = tx.send(result);
        });
    }

    /// /events 设备状态 SSE 订阅（事件驱动设备状态，docs/event-driven-plan.md 步骤 3）。
    /// 解析 `event:`/`data:` 帧 → 按 tag "events:<event>" 推送（body = data JSON 原文）；
    /// 连接断开/HTTP 错误 → tag "events:closed"（ok=false）——UI 侧重连判断。
    /// 注意与 get_sse（终端流，只取 base64 data）不同：事件流保留 event 名 + 原始 JSON。
    pub fn subscribe_events(&self, url: &str, token: &str) {
        let tx = self.tx.clone();
        let url = url.to_string();
        let token = token.to_string();
        std::thread::spawn(move || {
            use std::io::Read;
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(3600)) // 长连接（read 循环自身处理 EOF）
                .build()
                .unwrap();
            let resp = match client
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "text/event-stream")
                .send()
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(HttpResult { tag: "events:closed".into(), ok: false, body: String::new(), error: format!("SSE 连接失败: {e}") });
                    return;
                }
            };
            if !resp.status().is_success() {
                let _ = tx.send(HttpResult { tag: "events:closed".into(), ok: false, body: String::new(), error: format!("SSE HTTP {}", resp.status()) });
                return;
            }
            let mut reader = resp;
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            let mut ev_name = String::new();
            let mut ev_data = String::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break; // 连接关闭
                }
                pending.extend_from_slice(&buf[..n]);
                // 按 \n 切行（SSE 帧：event:/data:/空行；注释与 retry 行忽略）
                while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = pending.drain(..=pos).collect();
                    while matches!(line.last(), Some(b'\r') | Some(b'\n')) {
                        line.pop();
                    }
                    let line = String::from_utf8_lossy(&line);
                    if line.is_empty() {
                        // 帧结束：event + data 齐 → 推送（data 单行，server 端紧凑 JSON）
                        if !ev_name.is_empty() && !ev_data.is_empty() {
                            let _ = tx.send(HttpResult {
                                tag: format!("events:{ev_name}"),
                                ok: true,
                                body: std::mem::take(&mut ev_data),
                                error: String::new(),
                            });
                        }
                        ev_name.clear();
                        ev_data.clear();
                    } else if let Some(name) = line.strip_prefix("event:") {
                        ev_name = name.trim().to_string();
                    } else if let Some(d) = line.strip_prefix("data:") {
                        ev_data = d.trim().to_string();
                    }
                }
            }
            // 流结束（EOF/断开）
            let _ = tx.send(HttpResult { tag: "events:closed".into(), ok: false, body: String::new(), error: "连接断开".into() });
        });
    }

    /// SSE 流式 GET（终端输出流）：逐 `data:` 事件（base64 已解码、UTF-8 lossy）
    /// 经 channel 推送（固定 tag）；流结束/断开 → ok=false + error（重连判断用）。
    /// 注意：reqwest blocking 的分块 read（read 循环），不是一次性 text()。
    pub fn get_sse(&self, tag: impl Into<String>, url: &str, token: &str) {
        let tx = self.tx.clone();
        let tag = tag.into();
        let url = url.to_string();
        let token = token.to_string();
        std::thread::spawn(move || {
            use std::io::Read;
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(3600)) // 长连接（read 循环自身处理 EOF）
                .build()
                .unwrap();
            let resp = match client
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "text/event-stream")
                .send()
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(HttpResult { tag: tag.clone(), ok: false, body: String::new(), error: format!("SSE 连接失败: {e}") });
                    return;
                }
            };
            if !resp.status().is_success() {
                let _ = tx.send(HttpResult { tag: tag.clone(), ok: false, body: String::new(), error: format!("SSE HTTP {}", resp.status()) });
                return;
            }
            // 连接成功立即通知（空 body：UI 侧置 connected=true）。
            // 否则静默会话（无输出）永远显示「连接中」。
            let _ = tx.send(HttpResult { tag: tag.clone(), ok: true, body: String::new(), error: String::new() });
            let mut reader = resp;
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break; // 连接关闭
                }
                pending.extend_from_slice(&buf[..n]);
                // 按 \n 切行（SSE 事件行；心跳 `: p` 与空行忽略）
                while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = pending.drain(..=pos).collect();
                    while matches!(line.last(), Some(b'\r') | Some(b'\n')) {
                        line.pop();
                    }
                    if let Some(data) = line.strip_prefix(b"data:") {
                        let data = data.trim_ascii();
                        let decoded = base64_decode(std::str::from_utf8(data).unwrap_or(""));
                        let text = String::from_utf8_lossy(&decoded).to_string();
                        let _ = tx.send(HttpResult { tag: tag.clone(), ok: true, body: text, error: String::new() });
                    }
                }
            }
            // 流结束（EOF/断开）
            let _ = tx.send(HttpResult { tag, ok: false, body: String::new(), error: "连接断开".into() });
        });
    }
}

/// base64 编码（零依赖手写；终端输入字节经 base64 保真 POST）
pub fn base64_encode(data: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        out.push(B64[(b[0] >> 2) as usize] as char);
        out.push(B64[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[(((b[1] & 0x0F) << 2) | (b[2] >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { B64[(b[2] & 0x3F) as usize] as char } else { '=' });
    }
    out
}

/// base64 解码（零依赖手写；SSE 输出块为 base64 保真 VT 字节流）
pub fn base64_decode(s: &str) -> Vec<u8> {
    const TABLE: [i16; 256] = {
        let mut t = [-1i16; 256];
        let mut i = 0;
        while i < 26 {
            t[b'A' as usize + i] = i as i16;
            t[b'a' as usize + i] = (i + 26) as i16;
            i += 1;
        }
        i = 0;
        while i < 10 {
            t[b'0' as usize + i] = (i + 52) as i16;
            i += 1;
        }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = TABLE[c as usize];
        if v < 0 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

pub fn http_get_blocking(client: &reqwest::blocking::Client, url: &str, token: &str, timeout_secs: u64, tag: String) -> HttpResult {
    match client.get(url).timeout(Duration::from_secs(timeout_secs)).header("Authorization", format!("Bearer {token}")).send() {
        Ok(r) => {
            let ok = r.status().is_success();
            let error = if ok {
                String::new()
            } else {
                format!("HTTP {}", r.status())
            };
            HttpResult { tag, ok, body: r.text().unwrap_or_default(), error }
        }
        Err(e) => HttpResult { tag, ok: false, body: String::new(), error: e.to_string() },
    }
}

pub fn http_post_blocking(client: &reqwest::blocking::Client, url: &str, token: &str, body: &str, timeout_secs: u64, tag: String) -> HttpResult {
    match client
        .post(url)
        .timeout(Duration::from_secs(timeout_secs))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
    {
        Ok(r) => {
            let ok = r.status().is_success();
            let error = if ok {
                String::new()
            } else {
                format!("HTTP {}", r.status())
            };
            HttpResult { tag, ok, body: r.text().unwrap_or_default(), error }
        }
        Err(e) => HttpResult { tag, ok: false, body: String::new(), error: e.to_string() },
    }
}

/// MCP streamable HTTP（gca-server 与设备 MCP 端点通用）。
/// MCP 调用整体允许 120s（exec 长命令），连接建立用默认 connect_timeout。
pub fn mcp_call_blocking(client: &reqwest::blocking::Client, url: &str, token: &str, tool: &str, args: &serde_json::Value, tag: String) -> HttpResult {
    // 1. initialize
    let init_resp = match client
        .post(url)
        .timeout(Duration::from_secs(120))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": { "name": "gca-desktop-rs", "version": "0.3.0" } }
        }).to_string())
        .send()
    {
        Ok(r) => r,
        Err(e) => return HttpResult { tag, ok: false, body: String::new(), error: format!("MCP 连接失败: {e}") },
    };
    let session_id = init_resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let _ = init_resp.text();

    // 2. tools/call
    let mut req = client
        .post(url)
        .timeout(Duration::from_secs(120))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": tool, "arguments": args }
        }).to_string());
    if !session_id.is_empty() {
        req = req.header("mcp-session-id", &session_id);
    }
    let text = match req.send() {
        Ok(r) => r.text().unwrap_or_default(),
        Err(e) => return HttpResult { tag, ok: false, body: String::new(), error: format!("MCP 调用失败: {e}") },
    };

    let parsed: serde_json::Value = if let Some(m) = text.split("data: ").nth(1) {
        serde_json::from_str(m.trim()).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
    };

    if let Some(err) = parsed.get("error") {
        return HttpResult {
            tag,
            ok: false,
            body: String::new(),
            error: err.get("message").and_then(|m| m.as_str()).unwrap_or("MCP 错误").to_string(),
        };
    }
    let content = parsed.pointer("/result/content/0/text").and_then(|t| t.as_str()).unwrap_or("");
    HttpResult { tag, ok: true, body: content.to_string(), error: String::new() }
}
