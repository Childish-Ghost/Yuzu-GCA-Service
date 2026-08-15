//! clipboard_sync 工具：读写系统剪贴板（剪贴板可能含密码——get/set
//! 都走确认流程，与 node 版一致）。
//! 零依赖：PowerShell + System.Windows.Forms.Clipboard（powershell.exe 默认 STA），
//! 读取时把 UTF-8 字节直接写标准输出（绕开 5.1 重定向的 GBK 控制台编码）。
//! 与 node 版相同上限：10K 字符。

use crate::pending::{self, PendingOp};
use crate::ps;
use super::ToolDef;

const MAX_TEXT_CHARS: usize = 10240;

// 与 node 版 clipboard.ts 相同：UTF-8 字节直写 stdout，中文不乱码
const PS_GET: &str = r#"
Add-Type -AssemblyName System.Windows.Forms;
$text = [System.Windows.Forms.Clipboard]::GetText();
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text);
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length);
"#;

const PS_SET: &str = r#"
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Clipboard]::SetText($env:GCA_CLIP_TEXT);
"#;

pub fn def() -> ToolDef {
    ToolDef {
        name: "clipboard_sync",
        description: "Read or write the system clipboard on this device (privacy-sensitive). Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["get", "set"] },
                "text": { "type": "string", "description": "Text to write (set action only)" }
            },
            "required": ["action"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let action = args
        .get("action")
        .and_then(|a| a.as_str())
        .filter(|a| *a == "get" || *a == "set")
        .ok_or_else(|| "action required (get/set)".to_string())?
        .to_string();
    let text = args.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();

    if action == "set" && text.is_empty() {
        return Ok(serde_json::json!({ "status": "error", "error": "set action requires text" }));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Ok(serde_json::json!({
            "status": "error",
            "error": format!("Text too long ({} chars, cap is {MAX_TEXT_CHARS})", text.chars().count()),
        }));
    }

    let token = pending::push(PendingOp::ClipboardSync { action: action.clone(), text });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": "clipboard_sync",
        "reason": format!("{} the system clipboard on this device (may contain sensitive data). Nothing has been executed yet.", if action == "get" { "Read" } else { "Write" }),
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }))
}

pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::ClipboardSync { action, text } = op else {
        return serde_json::json!({ "status": "error", "error": "not a clipboard_sync op" });
    };
    match action.as_str() {
        "get" => {
            // Android 原生化 P2：JNI 回调 ClipboardManager（系统剪贴板）
            #[cfg(target_os = "android")]
            {
                match crate::jni_bridge::android_get_clipboard() {
                    Some(content) if !content.is_empty() => serde_json::json!({
                        "status": "read",
                        "chars": content.chars().count(),
                        "content": content.chars().take(MAX_TEXT_CHARS).collect::<String>(),
                        "confirmedByUser": true,
                    }),
                    Some(_) => serde_json::json!({
                        "status": "read",
                        "chars": 0,
                        "content": "",
                        "confirmedByUser": true,
                        "note": "clipboard empty or read restricted (Android 10+ blocks background clipboard reads unless the app has screen focus)",
                    }),
                    None => serde_json::json!({ "status": "error", "error": "clipboard unavailable (JNI bridge)" }),
                }
            }
            #[cfg(not(target_os = "android"))]
            match ps::run(PS_GET, &[], 10000) {
                Ok((out, _)) => {
                    // UTF-8 字节直写，无尾部换行；截断到上限
                    let content: String = out.chars().take(MAX_TEXT_CHARS).collect();
                    serde_json::json!({
                        "status": "read",
                        "chars": content.chars().count(),
                        "content": content,
                        "confirmedByUser": true,
                    })
                }
                Err(e) => serde_json::json!({ "status": "error", "error": e }),
            }
        },
        "set" => {
            // Android 原生化 P2：JNI 回调 ClipboardManager
            #[cfg(target_os = "android")]
            {
                if crate::jni_bridge::android_set_clipboard(text) {
                    serde_json::json!({ "status": "written", "chars": text.chars().count(), "confirmedByUser": true })
                } else {
                    serde_json::json!({ "status": "error", "error": "clipboard write failed (JNI bridge)" })
                }
            }
            #[cfg(not(target_os = "android"))]
            match ps::run(PS_SET, &[("GCA_CLIP_TEXT", text.clone())], 10000) {
                Ok(_) => serde_json::json!({
                    "status": "written",
                    "chars": text.chars().count(),
                    "confirmedByUser": true,
                }),
                Err(e) => serde_json::json!({ "status": "error", "error": e }),
            }
        },
        _ => serde_json::json!({ "status": "error", "error": "unknown action" }),
    }
}
