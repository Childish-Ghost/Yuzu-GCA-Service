//! 零依赖 HTTP（std::net）：server 每连接一线程解析请求，路由到
//! /health、/mcp、/transfer；client 用于 file_fetch 下载（含重定向/分块）。
//! 简单够用——MCP 客户端每次请求独立连接。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub extra_headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// 设置后按文件流式输出（/transfer 大文件，避免 2GB 进内存）
    pub stream_file: Option<(PathBuf, u64)>,
    /// SSE 长连接：头写完后调用（持有 TcpStream 持续写事件，直到断开）。
    /// 无 Content-Length（close-delimited），客户端读到 EOF 即结束。
    pub stream_hook: Option<Box<dyn Fn(&mut TcpStream) + Send>>,
}

impl Response {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            extra_headers: Vec::new(),
            body: body.to_string().into_bytes(),
            stream_file: None,
            stream_hook: None,
        }
    }
    /// 一次性票据文件下载（单次使用，Content-Length 由调用方给）
    pub fn file(path: PathBuf, size: u64) -> Self {
        Self {
            status: 200,
            content_type: "application/octet-stream",
            extra_headers: vec![("X-Transfer-Size".to_string(), size.to_string())],
            body: Vec::new(),
            stream_file: Some((path, size)),
            stream_hook: None,
        }
    }
    /// SSE 长连接响应：text/event-stream + 无 Content-Length。
    /// hook 持有 TcpStream 持续写 `data: ...` 事件，直到连接断开/返回。
    pub fn sse(hook: Box<dyn Fn(&mut TcpStream) + Send>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            extra_headers: vec![
                ("Cache-Control".to_string(), "no-cache".to_string()),
                ("X-Accel-Buffering".to_string(), "no".to_string()),
            ],
            body: Vec::new(),
            stream_file: None,
            stream_hook: Some(hook),
        }
    }
    #[allow(dead_code)] // 工具返回 mcp-session-id 时使用
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.extra_headers.push((name.to_string(), value.to_string()));
        self
    }
    pub fn not_found() -> Self {
        Self::json(404, serde_json::json!({ "error": "not found" }))
    }
}

pub fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = [0u8; 8192];
    let mut data = Vec::new();
    // 读到请求头结束
    let header_end = loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(pos) = find_sub(&data, b"\r\n\r\n") {
            break pos + 4;
        }
        if data.len() > 65536 {
            return None; // header 过大
        }
    };

    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    for (k, v) in &headers {
        if k.eq_ignore_ascii_case("content-length") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }

    // 读 body
    let mut body = data[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
        if body.len() > 8 * 1024 * 1024 {
            return None; // body 过大
        }
    }

    Some(Request { method, path, headers, body })
}

pub fn write_response(stream: &mut TcpStream, resp: &Response) {
    let status_text = match resp.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Status",
    };
    // 流式文件响应：Content-Length 取文件大小，body 分块写出；
    // SSE 长连接：无 Content-Length（close-delimited）
    let content_length = match &resp.stream_file {
        Some((_, size)) => *size,
        None => {
            if resp.stream_hook.is_some() {
                0
            } else {
                resp.body.len() as u64
            }
        }
    };
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\n",
        resp.status, status_text, resp.content_type
    );
    if resp.stream_hook.is_none() {
        out.push_str(&format!("Content-Length: {content_length}\r\n"));
    }
    out.push_str("Connection: close\r\n");
    for (k, v) in &resp.extra_headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes());

    if let Some((path, _)) = &resp.stream_file {
        // 64KB 分块流式读文件（源文件缺失时截断连接）
        if let Ok(mut f) = std::fs::File::open(path) {
            let mut chunk = [0u8; 65536];
            loop {
                match f.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stream.write_all(&chunk[..n]).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    } else if let Some(hook) = &resp.stream_hook {
        // SSE：hook 持续写事件直到返回（连接断开或会话结束）
        hook(stream);
    } else {
        let _ = stream.write_all(&resp.body);
    }
    let _ = stream.flush();
}

pub fn serve(
    port: u16,
    handler: std::sync::Arc<dyn Fn(Request) -> Response + Send + Sync>,
) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let handler = handler.clone();
        std::thread::spawn(move || {
            let Ok(mut s) = stream.try_clone() else { return };
            // 读超时：慢速连接（Slowloris）不永久占线程/句柄（2026-08-11 审查）
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(30)));
            if let Some(req) = read_request(&mut s) {
                let resp = handler(req);
                write_response(&mut s, &resp);
            }
        });
    }
    Ok(())
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------
// 极简 HTTP GET 客户端（file_fetch 下载用）：http:// 仅、跟随重定向（≤5）、
// Content-Length 校验、chunked 支持、大小上限。
// ---------------------------------------------------------------------------

pub struct GetOutcome {
    pub bytes: Vec<u8>,
    /// 服务端给了 Content-Length 且实际字节数一致
    pub size_matches: bool,
}

/// 下载 URL 到内存（file_fetch 数据量有限，一次全收）。
pub fn get(url: &str, timeout_ms: u64, max_bytes: usize) -> Result<GetOutcome, String> {
    let mut current = url.to_string();
    for _ in 0..5 {
        match get_once(&current, timeout_ms, max_bytes)? {
            Once::Redirect(loc) => current = resolve_url(&current, &loc)?,
            Once::Body(outcome) => return Ok(outcome),
        }
    }
    Err("Too many redirects".to_string())
}

enum Once {
    Redirect(String),
    Body(GetOutcome),
}

/// 请求头/首段 body 的缓冲读（chunked 续读与首读共用）
struct BufReader {
    stream: TcpStream,
    pending: Vec<u8>,
}

impl BufReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Ok(n);
        }
        self.stream.read(buf)
    }
    fn read_line(&mut self) -> Result<String, String> {
        let mut s = Vec::new();
        let mut b = [0u8; 1];
        loop {
            let n = self.read(&mut b).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("connection closed mid-line".into());
            }
            if b[0] == b'\n' {
                break;
            }
            if b[0] != b'\r' {
                s.push(b[0]);
            }
            if s.len() > 8192 {
                return Err("line too long".into());
            }
        }
        Ok(String::from_utf8_lossy(&s).to_string())
    }
}

fn get_once(url: &str, timeout_ms: u64, max_bytes: usize) -> Result<Once, String> {
    let (host, port, path) = parse_url(url)?;
    let addr = format!("{host}:{port}");
    let addr: std::net::SocketAddr = addr
        .parse()
        .map_err(|e| format!("bad address {addr}: {e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(5))
        .map_err(|e| format!("connect {addr} failed: {e}"))?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(timeout_ms)));

    let host_header = if port == 80 { host.to_string() } else { format!("{host}:{port}") };
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| format!("send failed: {e}"))?;

    // 读状态行 + 头
    let mut reader = BufReader { stream, pending: Vec::new() };
    let status_line = reader.read_line()?;
    let mut parts = status_line.split_whitespace();
    let _proto = parts.next();
    let code: u16 = parts
        .next()
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| format!("bad status line: {status_line}"))?;

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let line = reader.read_line()?;
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }

    if (300..400).contains(&code) {
        let loc = headers
            .iter()
            .find(|(k, _)| k == "location")
            .map(|(_, v)| v.clone())
            .ok_or("redirect without Location header")?;
        return Ok(Once::Redirect(loc));
    }
    if !(200..300).contains(&code) {
        return Err(format!("HTTP {code} (ticket invalid, expired, or already used)"));
    }

    let content_length: Option<usize> = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok());
    let chunked = headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"));

    let mut body: Vec<u8> = Vec::new();
    if chunked {
        decode_chunked(&mut reader, &mut body, max_bytes)?;
    } else if let Some(cl) = content_length {
        let mut buf = [0u8; 8192];
        while body.len() < cl {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            let room = cl - body.len();
            body.extend_from_slice(&buf[..n.min(room)]);
            if body.len() > max_bytes {
                return Err(format!("body exceeds {max_bytes} bytes cap"));
            }
        }
    } else {
        // 无 Content-Length：读到 EOF（上限保护）
        let mut buf = [0u8; 8192];
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&buf[..n]);
            if body.len() > max_bytes {
                return Err(format!("body exceeds {max_bytes} bytes cap"));
            }
        }
    }

    Ok(Once::Body(GetOutcome {
        size_matches: content_length.map_or(true, |cl| body.len() == cl),
        bytes: body,
    }))
}

fn decode_chunked(reader: &mut BufReader, body: &mut Vec<u8>, max_bytes: usize) -> Result<(), String> {
    loop {
        let line = reader.read_line()?;
        let size = usize::from_str_radix(line.trim_end(), 16).map_err(|_| "bad chunk size line")?;
        if size == 0 {
            let _ = reader.read_line()?; // 结尾 CRLF（或 trailer 首行）
            break;
        }
        let start = body.len();
        let mut b = [0u8; 8192];
        while body.len() - start < size {
            let want = (size - (body.len() - start)).min(b.len());
            let n = reader.read(&mut b[..want]).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("chunk truncated".into());
            }
            body.extend_from_slice(&b[..n]);
            if body.len() > max_bytes {
                return Err(format!("body exceeds {max_bytes} bytes cap"));
            }
        }
        let _ = reader.read_line()?; // chunk 尾部 CRLF
    }
    Ok(())
}

/// http://host[:port]/path 解析；仅 http:// 支持（与 node 版一致）
fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.strip_prefix("http://").ok_or("only http:// URLs are supported")?;
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h, p.parse::<u16>().unwrap_or(80))
        }
        _ => (host_port, 80),
    };
    if host.is_empty() {
        return Err("empty host".into());
    }
    Ok((host.to_string(), port, path.to_string()))
}

fn resolve_url(base: &str, loc: &str) -> Result<String, String> {
    if loc.starts_with("http://") || loc.starts_with("https://") {
        return Ok(loc.to_string());
    }
    if loc.starts_with('/') {
        let (host, port, _) = parse_url(base)?;
        let port_part = if port == 80 { String::new() } else { format!(":{port}") };
        return Ok(format!("http://{host}{port_part}{loc}"));
    }
    Err(format!("unsupported redirect target: {loc}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_variants() {
        let (h, p, path) = parse_url("http://<网关IP>:18790/health").unwrap();
        assert_eq!((h.as_str(), p, path.as_str()), ("<网关IP>", 18790, "/health"));

        let (h, p, path) = parse_url("http://example.com").unwrap();
        assert_eq!((h.as_str(), p, path.as_str()), ("example.com", 80, "/"));

        let (h, p, path) = parse_url("http://192.168.1.5:3001/mcp").unwrap();
        assert_eq!((h.as_str(), p, path.as_str()), ("192.168.1.5", 3001, "/mcp"));
    }

    #[test]
    fn parse_url_rejects_non_http() {
        assert!(parse_url("https://example.com").is_err());
        assert!(parse_url("ftp://x").is_err());
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("").is_err());
    }

    #[test]
    fn resolve_url_forms() {
        assert_eq!(
            resolve_url("http://a:3001/transfer/t1", "/transfer/t2").unwrap(),
            "http://a:3001/transfer/t2"
        );
        assert_eq!(
            resolve_url("http://a/transfer/t1", "http://b/x").unwrap(),
            "http://b/x"
        );
        assert!(resolve_url("http://a", "ftp://b").is_err());
    }
}
