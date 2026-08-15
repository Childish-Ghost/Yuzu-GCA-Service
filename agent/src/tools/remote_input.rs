//! remote_input 工具：键鼠控制（最高风险工具）。
//! 隐私模型与 node 版一致：input_consent 窗口内直接执行；窗口外每个动作需确认。
//! 零依赖：PowerShell Add-Type C# P/Invoke user32 SendInput（鼠标）+ SendKeys（打字）。

use crate::consent::{self, ConsentKind};
use crate::pending::{self, PendingOp};
use crate::ps;
use super::ToolDef;

/// SendKeys 特殊字符转义（`{}[]()+^%~` 会被当作修饰键/键名）——
/// 转义后按字面发送（2026-08-11 审查修复）
fn escape_sendkeys(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '{' => out.push_str("{{}"),
            '}' => out.push_str("{}}"),
            '+' => out.push_str("{+}"),
            '^' => out.push_str("{^}"),
            '%' => out.push_str("{%}"),
            '~' => out.push_str("{~}"),
            '(' => out.push_str("{(}"),
            ')' => out.push_str("{)}"),
            '[' => out.push_str("{[}"),
            ']' => out.push_str("{]}"),
            _ => out.push(c),
        }
    }
    out
}

/// C# P/Invoke 包装（与 node 版 input-simulator.ts 相同；无双引号冲突，
/// 外层用 PS 单引号字符串包裹）
const CS_CODE: &str = r#"using System;
using System.Runtime.InteropServices;

public class GcaInput {
    [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    const uint INPUT_MOUSE = 0;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_WHEEL = 0x0800;

    public static void Move(int x, int y) {
        SetCursorPos(x, y);
    }

    public static void Click(string button) {
        uint down, up;
        switch (button) {
            case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
            case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
            default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
        }
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].mi.dwFlags = down;
        inputs[1].type = INPUT_MOUSE; inputs[1].mi.dwFlags = up;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Scroll(int delta) {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.mouseData = (uint)delta;
        inputs[0].mi.dwFlags = MOUSEEVENTF_WHEEL;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"#;

pub fn def() -> ToolDef {
    ToolDef {
        name: "remote_input",
        description: "Send keyboard and mouse events to the device desktop (highest-risk tool). Gated by input_consent window or per-action confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["mouse_move", "mouse_click", "mouse_scroll", "key_type"] },
                "x": { "type": "number", "description": "Absolute X screen coordinate (mouse actions)" },
                "y": { "type": "number", "description": "Absolute Y screen coordinate (mouse actions)" },
                "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button (mouse_click only). Default left" },
                "delta": { "type": "number", "description": "Scroll delta (positive=up, negative=down). mouse_scroll only" },
                "text": { "type": "string", "description": "Text to type (key_type only). Max 1024 chars" }
            },
            "required": ["action"]
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let action = args
        .get("action")
        .and_then(|a| a.as_str())
        .filter(|a| ["mouse_move", "mouse_click", "mouse_scroll", "key_type"].contains(a))
        .ok_or_else(|| "action required (mouse_move/mouse_click/mouse_scroll/key_type)".to_string())?
        .to_string();
    let x = args.get("x").and_then(|v| v.as_i64()).map(|i| i as i32);
    let y = args.get("y").and_then(|v| v.as_i64()).map(|i| i as i32);
    let button = args.get("button").and_then(|b| b.as_str()).filter(|b| *b == "left" || *b == "right" || *b == "middle").unwrap_or("left").to_string();
    let delta = args.get("delta").and_then(|d| d.as_i64()).unwrap_or(0) as i32;
    let text = args.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();

    // 参数校验（与 node 版一致，返回 isError 内容）
    match action.as_str() {
        "mouse_move" if x.is_none() || y.is_none() => {
            return Ok(serde_json::json!({ "status": "error", "error": "mouse_move requires x and y" }));
        }
        "key_type" if text.is_empty() => {
            return Ok(serde_json::json!({ "status": "error", "error": "key_type requires text" }));
        }
        _ => {}
    }

    // 同意窗口内：直接执行
    if consent::active(ConsentKind::Input) {
        return execute(&action, x, y, &button, delta, &text, false);
    }

    let token = pending::push(PendingOp::RemoteInput {
        action: action.clone(),
        x, y,
        button: button.clone(),
        delta,
        text: text.clone(),
    });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": "remote_input",
        "reason": format!("Execute {action} on this device's desktop (privacy-sensitive: it controls mouse/keyboard). Nothing has been executed yet. Tip: the input_consent tool can open a timed window that skips per-action confirmation."),
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }))
}

/// confirm 分发入口
pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    let PendingOp::RemoteInput { action, x, y, button, delta, text } = op else {
        return serde_json::json!({ "status": "error", "error": "not a remote_input op" });
    };
    match execute(action, *x, *y, button, *delta, text, true) {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "status": "error", "action": action, "error": e }),
    }
}

fn execute(
    action: &str,
    x: Option<i32>,
    y: Option<i32>,
    button: &str,
    delta: i32,
    text: &str,
    confirmed_by_user: bool,
) -> Result<serde_json::Value, String> {
    // Android 原生化 P2：JNI 回调 AccessibilityService 手势（tap/swipe/scroll；
    // key_type 需 IME 注入，暂 unsupported）
    #[cfg(target_os = "android")]
    {
        let kind = match action {
            "mouse_click" => "tap",
            "mouse_move" => "swipe",
            "mouse_scroll" => "scroll",
            "key_type" => "type",
            _ => "unsupported",
        };
        return match crate::jni_bridge::android_remote_input(kind, x.unwrap_or(0), y.unwrap_or(0), text) {
            Some(r) => Ok(serde_json::json!({ "status": "ok", "result": r, "confirmedByUser": confirmed_by_user })),
            None => Err("remote_input unavailable (JNI bridge)".to_string()),
        };
    }
    let (script, envs, timeout): (String, Vec<(&str, String)>, u64) = match action {
        "mouse_move" => (
            format!("Add-Type -Language CSharp -TypeDefinition '{CS_CODE}'; [GcaInput]::Move({}, {});", x.unwrap_or(0), y.unwrap_or(0)),
            vec![],
            5000,
        ),
        "mouse_click" => {
            let mut s = format!("Add-Type -Language CSharp -TypeDefinition '{CS_CODE}'");
            if let (Some(x), Some(y)) = (x, y) {
                s.push_str(&format!("; [GcaInput]::Move({x}, {y})"));
            }
            s.push_str(&format!("; [GcaInput]::Click('{button}');"));
            (s, vec![], 5000)
        }
        "mouse_scroll" => {
            let mut s = format!("Add-Type -Language CSharp -TypeDefinition '{CS_CODE}'");
            if let (Some(x), Some(y)) = (x, y) {
                s.push_str(&format!("; [GcaInput]::Move({x}, {y})"));
            }
            s.push_str(&format!("; [GcaInput]::Scroll({delta});"));
            (s, vec![], 5000)
        }
        "key_type" => (
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:GCA_INPUT_TEXT);".to_string(),
            // SendKeys 特殊字符转义（{}[]()+^%~ 会被当作修饰键/键名——
            // 如 "{x}" 抛异常、"~" 变回车，2026-08-11 审查修复）
            vec![("GCA_INPUT_TEXT", escape_sendkeys(text))],
            10000,
        ),
        _ => return Ok(serde_json::json!({ "status": "error", "error": "unknown action" })),
    };

    let detail = match action {
        "mouse_move" => format!("moved to ({}, {})", x.unwrap_or(0), y.unwrap_or(0)),
        "mouse_click" => match (x, y) {
            (Some(x), Some(y)) => format!("clicked {button} at ({x}, {y})"),
            _ => format!("clicked {button}"),
        },
        "mouse_scroll" => format!("scrolled {} ({delta})", if delta > 0 { "up" } else { "down" }),
        "key_type" => format!("typed \"{}\"", text.chars().take(50).collect::<String>()),
        _ => String::new(),
    };

    match ps::run(&script, &envs, timeout) {
        Ok(_) => Ok(serde_json::json!({
            "status": "executed",
            "action": action,
            "detail": detail,
            "confirmedByUser": confirmed_by_user,
        })),
        Err(e) => Ok(serde_json::json!({ "status": "error", "action": action, "error": e })),
    }
}
