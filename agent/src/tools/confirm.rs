//! confirm 工具：确认待处理写操作并执行。
//! D4 对齐（2026-08-12 审查，与 node 版同一协议）：
//!   - 带 token：pending::consume 精确消费（single-use，任意 kind 含 Power）
//!   - 无 token（裸确认）：取最近非 Power 操作（与 node consumeLatestOfKinds 一致）

use crate::pending;
use super::{exec, exec_background, file_ops, power, service};
use super::{clipboard_sync, consent_tools, file_transfer, remote_input, screenshot};
use super::CallOutcome;

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "confirm",
        description: "Confirm a pending write operation (exec/file_*/power/service/background/screenshot/remote_input/clipboard_sync/consent/file_serve/file_fetch). Pass the token from a confirmation_required response to confirm THAT exact operation (power actions always require a token). Omit token to confirm the latest non-power operation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "token": { "type": "string", "description": "confirmToken from a confirmation_required response. Required for power actions; optional otherwise (bare confirm = latest non-power operation)." }
            }
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<CallOutcome, String> {
    let token = args.get("token").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();

    let op = if token.is_empty() {
        pending::pop_latest()
    } else {
        pending::consume(&token)
    };

    match op {
        Some(op) => Ok(match &op {
            pending::PendingOp::Exec { .. } => CallOutcome::from(exec::run_confirmed(&op)),
            pending::PendingOp::FileWrite { .. }
            | pending::PendingOp::FileMove { .. }
            | pending::PendingOp::FileDelete { .. } => CallOutcome::from(file_ops::run_confirmed(&op)),
            pending::PendingOp::Power { .. } => CallOutcome::from(power::run_confirmed(&op)),
            pending::PendingOp::Service { .. } => CallOutcome::from(service::run_confirmed(&op)),
            pending::PendingOp::Background { .. } => CallOutcome::from(exec_background::run_confirmed(&op)),
            pending::PendingOp::Screenshot { .. } => screenshot::run_confirmed(&op),
            pending::PendingOp::RemoteInput { .. } => CallOutcome::from(remote_input::run_confirmed(&op)),
            pending::PendingOp::ClipboardSync { .. } => CallOutcome::from(clipboard_sync::run_confirmed(&op)),
            pending::PendingOp::InputConsent { .. } | pending::PendingOp::ScreenConsent { .. } => {
                CallOutcome::from(consent_tools::run_confirmed(&op))
            }
            pending::PendingOp::FileServe { .. } | pending::PendingOp::FileFetch { .. } => {
                CallOutcome::from(file_transfer::run_confirmed(&op))
            }
        }),
        None => Ok(serde_json::json!({
            "status": "confirm_failed",
            "executed": false,
            "reason": "Nothing to confirm: no matching pending operation (or the token/code is invalid, expired, or already used). Ask the user what they want to do first.",
        })
        .into()),
    }
}
