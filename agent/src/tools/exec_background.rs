//! exec_background 工具：后台执行命令（detached，日志写临时目录）。需确认。

use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::pending::{self, PendingOp};

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "exec_background",
        description: "Run a command in the background (detached, output to a log file). Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "cwd": { "type": "string" }
            },
            "required": ["command"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| "command required".to_string())?
        .to_string();
    let cwd = args.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string());

    let token = pending::push(PendingOp::Background { command: command.clone(), cwd });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "command": command,
        "executed": false,
        "expiresInSec": 300,
    }))
}

pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::Background { command, cwd } = op else {
        return serde_json::json!({ "status": "error", "error": "not a background op" });
    };
    let task_id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string();
    let log_path = std::env::temp_dir().join(format!("gca-bg-{task_id}.log"));

    let stdout: Stdio = match std::fs::File::create(&log_path) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    };
    let stderr: Stdio = match std::fs::File::create(log_path.with_extension("err.log")) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    };
    let mut c = Command::new("cmd");
    c.arg("/C")
        .arg(&format!("chcp 65001>nul && {command}"))
        .stdout(stdout)
        .stderr(stderr);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS(0x8) | CREATE_NO_WINDOW(0x08000000)
        c.creation_flags(0x08000008);
    }

    match c.spawn() {
        Ok(child) => serde_json::json!({
            "status": "started",
            "taskId": task_id,
            "pid": child.id(),
            "command": command,
            "logPath": log_path.to_string_lossy(),
            "confirmedByUser": true,
        }),
        Err(e) => serde_json::json!({ "status": "error", "command": command, "error": e.to_string() }),
    }
}
