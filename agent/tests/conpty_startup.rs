//! 启动缓冲测试：spawn 后延迟 subscribe，验证第一个订阅者能收到启动输出
//! （模拟「切换/重连后新会话启动输出已流逝」场景）。

use std::time::Duration;

use gca_agent::conpty::Session;

#[test]
fn delayed_subscribe_gets_startup() {
    let s = Session::spawn("cmd", 100, 30).expect("session spawn");
    // 等 2.5 秒：cmd 启动输出（\x1b[6n/banner/提示符）应已产生并进启动缓冲
    std::thread::sleep(Duration::from_millis(2500));
    let (rx, _sub) = s.subscribe(); // 第一个订阅者 → 拿走启动缓冲
    let got = rx.recv_timeout(Duration::from_secs(3)).expect("startup buffer should arrive");
    eprintln!("[startup] buffer {} bytes: {:?}", got.len(), String::from_utf8_lossy(&got[..got.len().min(100)]));
    assert!(
        !got.is_empty(),
        "startup buffer empty after 2.5s delay — cmd produced no output?"
    );
}
