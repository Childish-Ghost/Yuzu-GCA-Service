//! 渲染检查：把真实终端输出字节用 TermScreen 解析并打印网格行——
//! 定位"提示符消失/输入缩进"是 vte 解析问题还是上游字节问题。

use gca_desktop_rs::termview::{TermScreen, TermScreenHandler};
use vte::Parser;

#[test]
fn render_real_bytes() {
    // 读取收集的终端输出字节（bash 侧收集：curl SSE → base64 解码 → 存文件）
    let path = std::env::var("RENDER_BYTES").unwrap_or_else(|_| r"D:\Yuzu-GCA-Service\target\render_bytes.bin".into());
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("无法读取 {path}: {e}");
            return;
        }
    };
    eprintln!("字节数: {}", bytes.len());
    // 80x24 大网格（不裁剪内容——超出视口部分在终端里本就会被滚动）
    let mut screen = TermScreen::new(93, 50);
    let mut parser = Parser::new();
    parser.advance(&mut TermScreenHandler(&mut screen), &bytes);
    for y in 0..screen.rows() {
        let text: String = screen.line(y).iter().map(|c| c.ch).collect();
        if text.trim().is_empty() {
            continue;
        }
        eprintln!("[{y:02}] {text}");
    }
    let (cx, cy) = screen.cursor();
    eprintln!("光标: ({cx},{cy})");
}
