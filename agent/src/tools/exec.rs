//! exec 工具：gca-agent（AI 通道）无状态执行——每条命令独立 shell，
//! 审批三级别 + cwd 参数。输出编码 cmd=UTF-8（chcp 65001）。
//! （会话化执行已在 gca-term bin 独立实现，2026-08-11 审查清理死代码）

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::approval::{self, Level};
use crate::pending::{self, PendingOp};

const DEFAULT_TIMEOUT_MS: u64 = 30000;
/// 当前目录标记（会话内延迟展开）
const CWD_TAG: &str = "__GCA_CWD__=";
/// 退出码标记
const EXIT_TAG: &str = "__GCA_EXIT__=";

/// 会话 shell 类型（Windows 终端可选 cmd / Windows PowerShell）
#[derive(Clone, Copy, PartialEq)]
pub enum ShellKind {
    Cmd,
    PowerShell,
}

impl ShellKind {
    pub fn from_str(s: &str) -> ShellKind {
        if s.eq_ignore_ascii_case("powershell") {
            ShellKind::PowerShell
        } else {
            ShellKind::Cmd
        }
    }
}

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "exec",
        description: "Execute a shell command on this device (stateless: each command runs in its own shell; use cwd for working directory). Write/dangerous commands are gated by approval policy.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The shell command to execute" },
                "cwd": { "type": "string", "description": "Working directory (optional)" },
                "timeout": { "type": "number", "description": "Timeout in ms, max 300000 (default 30000)" }
            },
            "required": ["command"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "command required".to_string())?;
    let cwd = args.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string());
    let timeout_ms = args
        .get("timeout")
        .and_then(|t| t.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(300000);

    let classification = approval::classify(&command);
    match classification.level {
        Level::Dangerous => {
            crate::audit::push("exec_blocked", &command, "blocked"); // 安全事件（INT-005）
            Ok(serde_json::json!({
                "status": "blocked",
                "command": command,
                "reason": classification.reason,
                "executed": false,
            }))
        }
        Level::Write => {
            let token = pending::push(PendingOp::Exec {
                command: command.clone(),
                cwd,
                timeout_ms: Some(timeout_ms),
            });
            Ok(serde_json::json!({
                "status": "confirmation_required",
                "token": token,
                "command": command,
                "reason": classification.reason,
                "executed": false,
                "expiresInSec": 300,
                "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with the confirmToken. Expires in 300 seconds.",
            }))
        }
        Level::Readonly => {
            let r = execute(&command, cwd.as_deref(), timeout_ms);
            crate::audit::push("exec", &command, "executed"); // 免审批执行（INT-005）
            Ok(executed_json_stateless(&command, r))
        }
    }
}

/// 确认后的执行入口（defense in depth：重新分类，被阻止则拒绝）
pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::Exec { command, cwd, timeout_ms } = op else {
        return serde_json::json!({ "status": "error", "error": "not an exec op" });
    };
    let classification = approval::classify(command);
    if classification.level == Level::Dangerous {
        return serde_json::json!({
            "status": "blocked",
            "command": command,
            "reason": classification.reason,
            "executed": false,
        });
    }
    let r = execute(command, cwd.as_deref(), timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let mut v = executed_json_stateless(command, r);
    v["confirmedByUser"] = serde_json::json!(true);
    v
}



/// 输出上限（1MB——注释声称的截断，2026-08-11 审查确认此前未实现：
/// read_to_end 无界读入内存，type huge.log 可 OOM）
const OUTPUT_MAX: usize = 1024 * 1024;


/// 提取输出里的 __GCA_CWD__ / __GCA_EXIT__ 标记行（最后出现的），返回
/// (移除标记后的文本, cwd, 退出码)
fn extract_meta(text: &str) -> (String, Option<String>, Option<i32>) {
    let mut cwd: Option<String> = None;
    let mut exit: Option<i32> = None;
    let mut cleaned = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        // 找任一标记的最早出现
        let cwd_pos = rest.find(CWD_TAG);
        let exit_pos = rest.find(EXIT_TAG);
        let pos = match (cwd_pos, exit_pos) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let Some(pos) = pos else {
            cleaned.push_str(rest);
            break;
        };
        // 行首之前的普通内容保留（提示符残留等）
        let line_start = rest[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
        cleaned.push_str(&rest[..line_start]);
        // 值从标记之后开始（pos + 标记长——不能从 line_start 算，标记前可能有提示符）
        let marker_len = if rest[pos..].starts_with(CWD_TAG) { CWD_TAG.len() } else { EXIT_TAG.len() };
        let after_marker = pos + marker_len;
        let line_end = rest[after_marker..].find('\n').map(|p| after_marker + p).unwrap_or(rest.len());
        let value = rest[after_marker..line_end].trim().trim_matches('\r').to_string();
        if rest[pos..].starts_with(CWD_TAG) {
            if !value.is_empty() {
                cwd = Some(value);
            }
        } else if let Ok(code) = value.parse::<i32>() {
            exit = Some(code);
        }
        rest = &rest[line_end..];
    }
    (cleaned, cwd, exit)
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


// ---------------------------------------------------------------------------
// 无状态执行（gca-agent /mcp 的 exec 工具用）：每条命令独立 cmd /C 进程。
// ---------------------------------------------------------------------------

pub struct ExecOutcome {
    pub exit_code: i32,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub cwd: Option<String>,
    pub truncated: bool,
}

/// 一次性执行：Windows 用 cmd /V:ON /C + chcp 65001（UTF-8 输出）；
/// Android 用 /system/bin/sh（UTF-8 原生）——Android 原生化 P2（docs/android-native-plan.md）。
/// 末尾附加 CWD 标记返回执行后的实际目录（Windows `!CD!` / Android `$PWD`）。
pub fn execute(command: &str, cwd: Option<&str>, timeout_ms: u64) -> ExecOutcome {
    #[cfg(not(target_os = "android"))]
    let full = format!("chcp 65001>nul && {command} & echo {CWD_TAG}!CD!");
    #[cfg(not(target_os = "android"))]
    let mut cmd = Command::new("cmd");
    #[cfg(not(target_os = "android"))]
    cmd.arg("/V:ON").arg("/C").arg(&full);
    #[cfg(target_os = "android")]
    let full = format!("{command}\nprintf '{CWD_TAG}%s\\n' \"$PWD\"");
    #[cfg(target_os = "android")]
    let mut cmd = Command::new("/system/bin/sh");
    #[cfg(target_os = "android")]
    cmd.arg("-c").arg(&full);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let Ok(mut child) = cmd.spawn() else {
        return ExecOutcome { exit_code: -1, timed_out: false, stdout: String::new(), stderr: String::new(), cwd: None, truncated: false };
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // F3（2026-08-12 审查）：线程返回 (bytes, truncated)——截断发生时置位，
    // 此前 truncated 恒 false（RA6 需求追溯发现）
    let out_thread = stdout.map(|mut s| std::thread::spawn(move || {
        let mut v = Vec::new();
        // 1MB 截断（read_into 同款——防 type huge.log OOM）
        let mut tmp = [0u8; 8192];
        loop {
            match s.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    if v.len() < OUTPUT_MAX {
                        let take = n.min(OUTPUT_MAX - v.len());
                        v.extend_from_slice(&tmp[..take]);
                    }
                }
                Err(_) => break,
            }
        }
        let truncated = v.len() >= OUTPUT_MAX;
        (v, truncated)
    }));
    // C6 修复（2026-08-12 审查）：stderr 此前无界 read_to_end——命令向 stderr
    // 洪泛可 OOM。与 stdout 同款 1MB 截断。
    let err_thread = stderr.map(|mut s| std::thread::spawn(move || {
        let mut v = Vec::new();
        let mut tmp = [0u8; 8192];
        loop {
            match s.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    if v.len() < OUTPUT_MAX {
                        let take = n.min(OUTPUT_MAX - v.len());
                        v.extend_from_slice(&tmp[..take]);
                    }
                }
                Err(_) => break,
            }
        }
        let truncated = v.len() >= OUTPUT_MAX;
        (v, truncated)
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
                // POSIX/Android：SIGKILL 子进程
                let _ = child.kill();
            }
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }

    let (out, out_trunc) = out_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let (err, err_trunc) = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let exit_code = child.try_wait().ok().flatten().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    // 提取末尾 cwd 标记行并从输出移除
    let stdout = String::from_utf8_lossy(&out).into_owned();
    let (clean, cwd_out) = extract_stateless_cwd(&stdout);
    ExecOutcome {
        exit_code,
        timed_out,
        stdout: clean,
        stderr: String::from_utf8_lossy(&err).into_owned(),
        cwd: cwd_out,
        truncated: out_trunc || err_trunc,
    }
}

/// 提取无状态输出的 __GCA_CWD__= 行（最后出现的）并移除
fn extract_stateless_cwd(text: &str) -> (String, Option<String>) {
    let (clean, cwd, _) = extract_meta(text);
    (clean, cwd)
}

/// 无状态执行结果 JSON（gca-agent 的 exec 工具返回）
fn executed_json_stateless(command: &str, r: ExecOutcome) -> serde_json::Value {
    serde_json::json!({
        "status": "executed",
        "command": command,
        "exitCode": r.exit_code,
        "timedOut": r.timed_out,
        "truncated": r.truncated,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "cwd": r.cwd,
    })
}
