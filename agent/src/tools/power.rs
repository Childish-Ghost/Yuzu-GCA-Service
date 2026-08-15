//! power 工具：关机/重启/休眠/睡眠/取消。需确认（pending 队列）。

use crate::pending::{self, PendingOp};

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "power",
        description: "Power actions: shutdown/restart/sleep/hibernate/abort. Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["shutdown", "restart", "sleep", "hibernate", "abort"] }
            },
            "required": ["action"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let action = args
        .get("action")
        .and_then(|a| a.as_str())
        .filter(|a| ["shutdown", "restart", "sleep", "hibernate", "abort"].contains(a))
        .ok_or_else(|| "action required (shutdown/restart/sleep/hibernate/abort)".to_string())?
        .to_string();

    let token = pending::push(PendingOp::Power { action: action.clone() });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "action": action,
        "executed": false,
        "expiresInSec": 300,
        "note": "Power actions require confirmation. Call the MCP tool named \"confirm\" with the confirmToken.",
    }))
}

pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::Power { action } = op else {
        return serde_json::json!({ "status": "error", "error": "not a power op" });
    };
    // Android 原生化 P2：电源操作系统级不开放（与 node 版一致 unsupported）
    #[cfg(target_os = "android")]
    {
        return serde_json::json!({ "status": "unsupported", "action": action, "error": "power actions not available on Android" });
    }
    let cmd: Option<(&str, Vec<&str>)> = match action.as_str() {
        "shutdown" => Some(("shutdown", vec!["/s", "/t", "0"])),
        "restart" => Some(("shutdown", vec!["/r", "/t", "0"])),
        "sleep" => Some(("rundll32", vec!["powrprof.dll,SetSuspendState", "0,1,0"])),
        "hibernate" => Some(("shutdown", vec!["/h"])),
        "abort" => Some(("shutdown", vec!["/a"])),
        _ => None,
    };
    let Some((prog, args)) = cmd else {
        return serde_json::json!({ "status": "error", "action": action, "error": "unknown action" });
    };
    let mut c = std::process::Command::new(prog);
    c.args(&args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    match c.output() {
        Ok(_) => serde_json::json!({ "status": "ok", "action": action, "detail": "power action issued", "confirmedByUser": true }),
        Err(e) => serde_json::json!({ "status": "error", "action": action, "error": e.to_string() }),
    }
}
