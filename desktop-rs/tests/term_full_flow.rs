//! 完整流程集成测试：模拟用户「连接 → 启动 → 输入 dir → 输出」，
//! 检查屏幕提示符数量与空白行（定位排版问题：多提示符/空行溢出）。

use gca_desktop_rs::termview::TermView;
use std::time::Duration;

// 审查（2026-08-15 发布前敏感信息清理）：真实 token 不入库——测试从环境读取
const TOKEN: &str = option_env!("GCA_TEST_TOKEN").unwrap_or("test-only-token");

fn sse_collect(duration: Duration, on_block: &mut dyn FnMut(&str)) {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
    let resp = client.get("http://127.0.0.1:3011/term/sse")
        .header("Authorization", format!("Bearer {TOKEN}"))
        .header("Accept", "text/event-stream")
        .send().unwrap();
    use std::io::Read;
    let mut reader = resp;
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let deadline = std::time::Instant::now() + duration;
    while std::time::Instant::now() < deadline {
        if reader.read(&mut buf).unwrap_or(0) == 0 { break; }
        pending.extend_from_slice(&buf[..]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line).to_string();
            if let Some(data) = line.strip_prefix("data:") {
                let decoded = gca_desktop_rs::http::base64_decode(data.trim());
                on_block(&String::from_utf8_lossy(&decoded));
            }
        }
    }
}

fn post_input(data: &str) {
    let b = serde_json::json!({"data": gca_desktop_rs::http::base64_encode(data.as_bytes())}).to_string();
    let c = reqwest::blocking::Client::new();
    let _ = c.post("http://127.0.0.1:3011/term/input")
        .header("Authorization", format!("Bearer {TOKEN}"))
        .header("Content-Type", "application/json")
        .body(b)
        .send();
}

#[test]
fn full_flow_screen_state() {
    let mut tv = TermView::new(100, 40);
    tv.connected = true;
    // 1. 连接收启动缓冲
    sse_collect(Duration::from_secs(4), &mut |b| tv.feed(b.as_bytes()));
    // 2. 输入 dir
    post_input("dir\r\n");
    // 3. 收输出
    sse_collect(Duration::from_secs(3), &mut |b| tv.feed(b.as_bytes()));
    // 检查屏幕
    let mut prompts = 0;
    let mut blank = 0;
    for y in 0..tv.screen().rows() {
        let text: String = tv.screen().line(y).iter().map(|c| c.ch).collect();
        if text.contains('>') && text.contains("Yuzu") { prompts += 1; }
        if text.trim().is_empty() { blank += 1; }
    }
    eprintln!("提示符行数: {prompts} | 空白行: {blank}/{}", tv.screen().rows());
    assert!(prompts <= 2, "屏幕出现 {} 个提示符行（应 ≤2：启动+输入后）", prompts);
}
