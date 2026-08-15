//! ConPTY 会话冒烟测试（绕过 HTTP，直接验证 portable-pty 会话输出+输入链路）

use std::time::{Duration, Instant};

use gca_agent::conpty::Session;

#[test]
fn session_output_and_input() {
    let s = Session::spawn("cmd", 100, 30).expect("session spawn");
    let (rx, _sub) = s.subscribe();

    // 诊断：cmd 子进程是否活着（portable-pty 的 child 没有 process_id 暴露，
    // 通过 tasklist 看 cmd 进程变化——由测试环境断言输出即可）

    // 等启动输出（cmd banner/chcp/提示符）
    let mut got: Vec<u8> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(b) if !b.is_empty() => {
                got.extend_from_slice(&b);
                if got.len() > 4096 {
                    break;
                }
            }
            Ok(_) => break,
            Err(_) => {}
        }
    }
    eprintln!("[smoke] startup output {} bytes", got.len());
    eprintln!("[smoke] startup raw: {:?}", String::from_utf8_lossy(&got[..got.len().min(200)]));
    assert!(
        !got.is_empty(),
        "no startup output from ConPTY (bootstrap bytes: {:?})",
        String::from_utf8_lossy(&got[..got.len().min(100)])
    );

    // 应答 CPR（光标位置查询 \x1b[6n → \x1b[row;colR）——终端模拟器职责，
    // cmd 在 ConPTY 启动时等待此应答，不应答则卡住不处理输入
    s.write(b"\x1b[1;1R").expect("write CPR response");
    std::thread::sleep(Duration::from_millis(800));

    // 写输入 → 等回显
    s.write(b"echo smoke-echo-ok\r\n").expect("write input");
    let mut echoed: Vec<u8> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(b) if !b.is_empty() => {
                echoed.extend_from_slice(&b);
                if String::from_utf8_lossy(&echoed).contains("smoke-echo-ok") {
                    break;
                }
            }
            Ok(_) => break,
            Err(_) => {}
        }
    }
    let text = String::from_utf8_lossy(&echoed);
    eprintln!("[smoke] echo output {} bytes: {}", echoed.len(), text.chars().take(120).collect::<String>());
    assert!(
        text.contains("smoke-echo-ok"),
        "echo not echoed back (got: {:?})",
        text.chars().take(200).collect::<String>()
    );

    // resize 不崩
    s.resize(120, 40);
}
