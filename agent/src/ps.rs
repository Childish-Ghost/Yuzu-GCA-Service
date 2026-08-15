//! PowerShell 执行助手（零依赖系统能力入口）：
//!   环境变量传参（无引号注入面）、超时后 taskkill /T 杀进程树、
//!   CREATE_NO_WINDOW（不闪黑窗）、输出管道线程读取（防死锁）。

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 运行 powershell 脚本，超时杀树。成功返回 (stdout, stderr)。
/// 注意：本函数不处理输出编码——需要中文输出的脚本必须在脚本内
/// UTF-8 字节直写 stdout（[Console]::OpenStandardOutput().Write），
/// chcp/OutputEncoding 在重定向/无控制台时不可靠（实测）。
pub fn run(script: &str, envs: &[(&str, String)], timeout_ms: u64) -> Result<(String, String), String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let Ok(mut child) = cmd.spawn() else {
        return Err("powershell spawn failed".to_string());
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_thread = stdout.map(|mut s| std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        v
    }));
    let err_thread = stderr.map(|mut s| std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        v
    }));

    let start = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            timed_out = true;
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &child.id().to_string()])
                    .creation_flags_no_window()
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                // POSIX/Android：SIGKILL 子进程（Android 无 kill 命令，直接 std 杀）
                let _ = child.kill();
            }
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }

    let out = out_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let err = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let code = child.try_wait().ok().flatten().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    if timed_out {
        return Err(format!("powershell timed out after {timeout_ms}ms"));
    }
    if code != 0 {
        let msg = String::from_utf8_lossy(&err).trim().to_string();
        return Err(if msg.is_empty() { format!("powershell exited {code}") } else { msg });
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
}

#[cfg(target_os = "windows")]
trait CreationFlags {
    fn creation_flags_no_window(&mut self) -> &mut Command;
}

#[cfg(target_os = "windows")]
impl CreationFlags for Command {
    fn creation_flags_no_window(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000);
        self
    }
}
