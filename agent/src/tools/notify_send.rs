//! notify_send 工具：在设备上弹桌面通知（AI 联系键盘前的人）。
//! 只读类（不改系统状态），自动批准。与 node 版一致：
//! 主通道 msg.exe（Windows 内置），失败降级 server-log（agent stderr）。

use super::ToolDef;

pub fn def() -> ToolDef {
    ToolDef {
        name: "notify_send",
        description: "Pop a desktop notification on this device (reaches the human at the keyboard). Auto-approved.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string" },
                "title": { "type": "string", "description": "Default 'GCA'" }
            },
            "required": ["message"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let message = args
        .get("message")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .ok_or_else(|| "message required".to_string())?;
    let title = args.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or("GCA");

    // 净化（与 node 一致：去掉可能破坏命令行的字符）+ 240 字截断
    let raw = format!("{title}: {message}");
    let safe: String = raw.chars().map(|c| if "&|<>^\"%".contains(c) { ' ' } else { c }).take(240).collect();

    // Android 原生化 P2：JNI 回调 NotificationManager
    #[cfg(target_os = "android")]
    {
        if crate::jni_bridge::android_notify(title, message) {
            return Ok(serde_json::json!({ "status": "sent", "channel": "notification", "title": title }));
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let r = std::process::Command::new("msg")
            .args(["*", "/TIME:60", &safe])
            .creation_flags(0x08000000)
            .output();
        if let Ok(o) = r {
            if o.status.success() {
                return Ok(serde_json::json!({ "status": "sent", "channel": "msg.exe", "title": title }));
            }
        }
    }

    // 降级：server-log 通道（agent stderr → gca-poc.log）
    eprintln!("DESKTOP NOTIFICATION (server-log channel): {raw}");
    Ok(serde_json::json!({ "status": "sent", "channel": "server-log", "title": title }))
}
