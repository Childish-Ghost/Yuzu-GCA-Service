//! screenshot 工具：虚拟屏幕（全部显示器）JPEG 截图 + 可选 WinRT OCR 文本。
//! 隐私模型与 node 版一致：screen_consent 窗口内直接截；窗口外需确认。
//! 零依赖：PowerShell System.Drawing 截图（-EncodedCommand 等价物走
//! 环境变量传参），OCR 为 best-effort（引擎不可用/超时则返回空文本）。

use crate::consent::{self, ConsentKind};
use crate::pending::{self, PendingOp};
use crate::ps;
use super::{CallOutcome, ToolDef};

pub fn def() -> ToolDef {
    ToolDef {
        name: "screenshot",
        description: "Capture the virtual screen (all monitors) as JPEG, optionally with Windows OCR text. Gated by screen_consent window or per-shot confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "quality": { "type": "number", "description": "JPEG quality 10-95, default 70" },
                "ocr": { "type": "boolean", "description": "Also run built-in Windows OCR and include recognized text. Default true" }
            }
        }),
    }
}

const PS_CAPTURE: &str = r#"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size);
$ms = New-Object System.IO.MemoryStream;
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1;
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [int64]$env:GCA_JPEG_QUALITY);
$bmp.Save($ms, $codec, $ep);
$out = [ordered]@{ b64 = [Convert]::ToBase64String($ms.ToArray()); w = $vs.Width; h = $vs.Height; left = $vs.Left; top = $vs.Top };
$g.Dispose(); $bmp.Dispose(); $ms.Dispose();
[Console]::Out.Write((ConvertTo-Json -Compress $out));
"#;

const PS_OCR: &str = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$b64 = (Get-Content -Raw -Path $env:GCA_OCR_B64_FILE).Trim();
$ms = New-Object System.IO.MemoryStream (,[Convert]::FromBase64String($b64));
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
if ($null -eq $engine) { [Console]::Out.Write(''); exit 0; }
$stream = $ms.AsRandomAccessStream();
$decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult();
$bmp = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult();
$result = $engine.RecognizeAsync($bmp).GetAwaiter().GetResult();
$b = [System.Text.Encoding]::UTF8.GetBytes($result.Text);
[Console]::OpenStandardOutput().Write($b, 0, $b.Length);
"#;

pub fn run(args: &serde_json::Value) -> Result<CallOutcome, String> {
    let quality = args.get("quality").and_then(|q| q.as_u64()).unwrap_or(70).clamp(10, 95) as u8;
    let ocr = args.get("ocr").and_then(|o| o.as_bool()).unwrap_or(true);

    // 同意窗口内：直接截（与 node 一致）
    if consent::active(ConsentKind::Screen) {
        return Ok(execute(quality, ocr, false));
    }

    let token = pending::push(PendingOp::Screenshot { quality, ocr });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "operation": "screenshot",
        "reason": "Capture a screenshot of everything currently visible on this device's screen (privacy-sensitive). Nothing has been captured yet. Tip: the screen_consent tool can open a timed window that skips per-shot confirmation.",
        "executed": false,
        "expiresInSec": 300,
        "note": "Ask the user to confirm. When they agree, call the MCP tool named \"confirm\" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.",
    }).into())
}

/// confirm 分发入口（同意窗口外确认后执行）
pub fn run_confirmed(op: &PendingOp) -> CallOutcome {
    let PendingOp::Screenshot { quality, ocr } = op else {
        return serde_json::json!({ "status": "error", "error": "not a screenshot op" }).into();
    };
    execute(*quality, *ocr, true)
}

/// 执行截图（同意窗口路径或 confirm 路径），失败时返回 status:error 内容
/// （main.rs 据此置 isError），不向调用方抛错
fn execute(quality: u8, ocr: bool, confirmed_by_user: bool) -> CallOutcome {
    // Android 原生化 P2：JNI 回调 A11y takeScreenshot（GcaAccessibilityService.captureScreen）
    #[cfg(target_os = "android")]
    {
        match crate::jni_bridge::android_take_screenshot() {
            Some(bytes) => {
                let b64 = crate::base64::encode(&bytes);
                if b64.len() < 100 {
                    return serde_json::json!({ "status": "error", "error": "capture returned empty image (AccessibilityService not enabled?)" }).into();
                }
                let meta = serde_json::json!({
                    "status": "captured",
                    "width": 0, "height": 0, "left": 0, "top": 0,
                    "imageBytes": b64.len() * 3 / 4,
                    "format": "image/jpeg",
                    "ocrText": serde_json::Value::Null,
                    "confirmedByUser": confirmed_by_user,
                });
                return CallOutcome { text: meta, image: Some((b64, "image/jpeg".to_string())) };
            }
            None => return serde_json::json!({ "status": "error", "error": "screen capture unavailable (JNI bridge)" }).into(),
        }
    }
    let parsed = match ps::run(PS_CAPTURE, &[("GCA_JPEG_QUALITY", quality.to_string())], 20000)
        .map(|(out, _)| out)
        .and_then(|out| {
            serde_json::from_str::<serde_json::Value>(out.trim())
                .map_err(|e| format!("capture output parse failed: {e}"))
        }) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "status": "error", "error": format!("screen capture failed: {e}") }).into(),
    };
    let b64 = parsed.get("b64").and_then(|b| b.as_str()).unwrap_or("").to_string();
    if b64.len() < 100 {
        return serde_json::json!({ "status": "error", "error": "capture returned empty image (session locked or no desktop access?)" }).into();
    }
    let w = parsed.get("w").and_then(|v| v.as_u64()).unwrap_or(0);
    let h = parsed.get("h").and_then(|v| v.as_u64()).unwrap_or(0);
    let left = parsed.get("left").and_then(|v| v.as_i64()).unwrap_or(0);
    let top = parsed.get("top").and_then(|v| v.as_i64()).unwrap_or(0);

    // OCR（best-effort）：b64 走临时文件（Windows 环境变量上限 32K，大图会爆）
    let mut ocr_text = String::new();
    if ocr {
        let tmp = std::env::temp_dir().join(format!("gca-ocr-{}.b64", std::process::id()));
        let _ = std::fs::write(&tmp, &b64);
        let _ = ps::run(PS_OCR, &[("GCA_OCR_B64_FILE", tmp.to_string_lossy().to_string())], 30000)
            .map(|(out, _)| ocr_text = out.trim().to_string());
        let _ = std::fs::remove_file(&tmp);
    }

    let meta = serde_json::json!({
        "status": "captured",
        "width": w,
        "height": h,
        "left": left,
        "top": top,
        "imageBytes": b64.len() * 3 / 4,
        "format": "image/jpeg",
        "ocrText": if ocr_text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(ocr_text) },
        "confirmedByUser": confirmed_by_user,
    });
    CallOutcome { text: meta, image: Some((b64, "image/jpeg".to_string())) }
}
