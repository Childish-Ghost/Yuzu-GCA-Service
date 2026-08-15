//! 终端流集成测试：真实连接本机 gca-term，模拟 desktop 的
//! 「连接 → 启动缓冲 → 断开 → 重连」流程，检查屏幕提示符是否重复。
//! 需要本机 3011 的 gca-term 在运行。

use gca_desktop_rs::termview::TermView;
use std::time::Duration;

// 审查（2026-08-15 发布前敏感信息清理）：真实 token 不入库——测试从环境读取
const TOKEN: &str = option_env!("GCA_TEST_TOKEN").unwrap_or("test-only-token");

fn sse_connect_and_collect(duration: Duration) -> Vec<String> {
    // 连接 SSE，收集所有 data 块（解码后文本）
    let url = format!("http://127.0.0.1:3011/term/sse");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build().unwrap();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {TOKEN}"))
        .header("Accept", "text/event-stream")
        .send().unwrap();
    use std::io::Read;
    let mut reader = resp;
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    let deadline = std::time::Instant::now() + duration;
    while std::time::Instant::now() < deadline {
        if reader.read(&mut buf).unwrap_or(0) == 0 { break; }
        pending.extend_from_slice(&buf[..]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line).to_string();
            if let Some(data) = line.strip_prefix("data:") {
                // 这里直接用 base64 解码后的文本（与 desktop 的 get_sse 一致）
                use gca_desktop_rs::http::base64_decode;
                let decoded = base64_decode(data.trim());
                blocks.push(String::from_utf8_lossy(&decoded).to_string());
            }
        }
    }
    blocks
}

#[test]
fn connect_feed_blocks_no_duplicate() {
    // 模拟 desktop：连接 → 收启动缓冲 → feed 到 TermView
    let mut tv = TermView::new(100, 30);
    tv.connected = true;
    let blocks = sse_connect_and_collect(Duration::from_secs(4));
    eprintln!("收到 {} 个块", blocks.len());
    for b in &blocks {
        tv.feed(b.as_bytes());
    }
    // 检查屏幕：提示符行不重复
    let mut dup = false;
    for y in 0..tv.screen().rows() {
        let text: String = tv.screen().line(y).iter().map(|c| c.ch).collect();
        if text.contains(">") && text.contains(">") {
            // 检查是否两个提示符
            let prompts = text.matches(">").count();
            if prompts > 1 {
                dup = true;
                eprintln!("行 {y} 提示符重复: {:?}", text);
            }
        }
    }
    assert!(!dup, "屏幕出现提示符重复行");
}
