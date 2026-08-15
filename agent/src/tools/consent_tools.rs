//! consent 工具：screen_consent（截图免确认窗口）与 input_consent（键鼠免确认窗口）。
//! minutes=0 即时撤销（提升隐私，免确认）；授予需经 confirm 流程。
//! 与 node 版语义一致（状态存内存，agent 重启即撤销——更安全方向）。

use crate::consent::{self, ConsentKind};
use crate::pending::{self, PendingOp};
use super::ToolDef;

pub fn def_screen() -> ToolDef {
    ToolDef {
        name: "screen_consent",
        description: "Grant/revoke a time-boxed window during which screenshots run WITHOUT per-shot confirmation. minutes=0 revokes instantly; granting requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "minutes": { "type": "number", "description": "Window length in minutes. 0 = revoke" }
            },
            "required": ["minutes"]
        }),
    }
}

pub fn def_input() -> ToolDef {
    ToolDef {
        name: "input_consent",
        description: "Grant/revoke a time-boxed window during which remote_input runs WITHOUT per-action confirmation. minutes=0 revokes instantly; granting requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "minutes": { "type": "number", "description": "Window length in minutes. 0 = revoke" }
            },
            "required": ["minutes"]
        }),
    }
}

pub fn run_screen(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    run_common(ConsentKind::Screen, "screen_consent", "screenshot consent", args)
}

pub fn run_input(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    run_common(ConsentKind::Input, "input_consent", "input consent", args)
}

fn run_common(kind: ConsentKind, operation: &str, window_name: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    // Android 原生化 P2：同意窗口需要原生对话框（前台 Activity），当前 unsupported
    //（截图的每帧确认走 pending 审批；与 node 版行为对齐）
    #[cfg(target_os = "android")]
    {
        return Ok(serde_json::json!({
            "status": "unsupported",
            "operation": operation,
            "error": "consent windows not available on Android (per-shot confirmation still works)",
        }));
    }
    let minutes = args.get("minutes").and_then(|m| m.as_u64()).unwrap_or(0);

    // 撤销：即时生效（提升隐私，不需确认）
    if minutes == 0 {
        consent::revoke(kind);
        return Ok(serde_json::json!({ "status": "revoked", "active": false }));
    }

    let (active, until) = consent::status(kind);
    if active {
        return Ok(serde_json::json!({
            "status": "already_active",
            "until": until,
            "note": format!("A {window_name} window is already active. Revoke it first with minutes=0 if you need a fresh one."),
        }));
    }

    let op = match kind {
        ConsentKind::Screen => PendingOp::ScreenConsent { minutes: minutes as u32 },
        ConsentKind::Input => PendingOp::InputConsent { minutes: minutes as u32 },
    };
    let token = pending::push(op);
    let reason = if kind == ConsentKind::Screen {
        format!("Grant a {minutes}-minute window during which screenshots may be captured WITHOUT per-shot confirmation. Nothing changes yet.")
    } else {
        format!("Grant a {minutes}-minute window during which remote_input runs WITHOUT per-action confirmation. This gives the AI full keyboard+mouse control of this device. Nothing changes yet.")
    };
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": operation,
        "reason": reason,
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }))
}

/// confirm 分发入口（授予窗口）
pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    match op {
        PendingOp::ScreenConsent { minutes } => grant_json(ConsentKind::Screen, "screen_consent", "Screenshots", *minutes),
        PendingOp::InputConsent { minutes } => grant_json(ConsentKind::Input, "input_consent", "Remote input", *minutes),
        _ => serde_json::json!({ "status": "error", "error": "not a consent op" }),
    }
}

fn grant_json(kind: ConsentKind, operation: &str, what: &str, minutes: u32) -> serde_json::Value {
    let until = consent::grant(kind, minutes);
    serde_json::json!({
        "status": "granted",
        "minutes": minutes,
        "until": until,
        "confirmedByUser": true,
        "note": format!("{what} may now run without per-confirmation until {until}. Revoke anytime via {operation} with minutes=0."),
    })
}
