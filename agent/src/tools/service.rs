//! service 工具：list（只读自动批准）/ start / stop / restart（需确认）。

use crate::pending::{self, PendingOp};

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "service",
        description: "Windows service management: list (read-only) or start/stop/restart (requires confirmation).",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "start", "stop", "restart"] },
                "name": { "type": "string", "description": "Service name for start/stop/restart" }
            },
            "required": ["action"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let action = args
        .get("action")
        .and_then(|a| a.as_str())
        .filter(|a| ["list", "start", "stop", "restart"].contains(a))
        .ok_or_else(|| "action required (list/start/stop/restart)".to_string())?
        .to_string();

    // list：只读，直接执行
    if action == "list" {
        return run_list();
    }

    let name = args
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| "name required for start/stop/restart".to_string())?
        .to_string();

    let token = pending::push(PendingOp::Service { action: action.clone(), name: name.clone() });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "action": action,
        "name": name,
        "executed": false,
        "expiresInSec": 300,
    }))
}

fn run_list() -> Result<serde_json::Value, String> {
    let mut c = std::process::Command::new("powershell");
    c.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // 输出 UTF-8 字节直写（chcp/OutputEncoding 在重定向时不可靠，实测）
        "Get-Service | ForEach-Object { [PSCustomObject]@{ Name=$_.Name; DisplayName=$_.DisplayName; Status=$_.Status.ToString() } } | ConvertTo-Json -Compress | ForEach-Object { $b=[System.Text.Encoding]::UTF8.GetBytes($_); [Console]::OpenStandardOutput().Write($b,0,$b.Length) }",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let out = c.output().map_err(|e| format!("powershell failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    let rows: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    };
    let services: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "name": r.get("Name").and_then(|n| n.as_str()).unwrap_or(""),
                "displayName": r.get("DisplayName").and_then(|n| n.as_str()).unwrap_or(""),
                "status": r.get("Status").and_then(|n| n.as_str()).unwrap_or(""),
            })
        })
        .collect();
    Ok(serde_json::json!({ "status": "ok", "services": services, "total": services.len() }))
}

pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::Service { action, name } = op else {
        return serde_json::json!({ "status": "error", "error": "not a service op" });
    };
    // Android 原生化 P2：Windows 服务管理不适用于 Android（与 node 版一致 unsupported）
    #[cfg(target_os = "android")]
    {
        return serde_json::json!({ "status": "unsupported", "action": action, "error": "service management not available on Android" });
    }
    // 服务名经环境变量传参（不拼接进命令字符串）——防注入：
    // name 含 '; 等字符时直接拼接可执行任意 PS 语句（2026-08-11 审查修复）
    let ps_cmd = match action.as_str() {
        "start" => "Start-Service -Name $env:GCA_SVC_NAME -ErrorAction Stop".to_string(),
        "stop" => "Stop-Service -Name $env:GCA_SVC_NAME -ErrorAction Stop".to_string(),
        "restart" => "Restart-Service -Name $env:GCA_SVC_NAME -ErrorAction Stop".to_string(),
        _ => return serde_json::json!({ "status": "error", "action": action, "error": "unknown action" }),
    };
    let mut c = std::process::Command::new("powershell");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
        .env("GCA_SVC_NAME", name);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    match c.output() {
        Ok(o) if o.status.success() => serde_json::json!({
            "status": "ok",
            "action": action,
            "name": name,
            "confirmedByUser": true,
        }),
        Ok(o) => serde_json::json!({
            "status": "error",
            "action": action,
            "name": name,
            "error": String::from_utf8_lossy(&o.stderr).trim().to_string(),
        }),
        Err(e) => serde_json::json!({ "status": "error", "action": action, "name": name, "error": e.to_string() }),
    }
}
