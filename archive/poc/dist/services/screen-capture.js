/**
 * Screen Capture (R-001) - screenshots via built-in Windows APIs.
 *
 * Zero dependencies:
 *   - Capture: PowerShell + System.Drawing (CopyFromScreen, JPEG to memory)
 *   - OCR (optional, best-effort): WinRT Windows.Media.Ocr with profile
 *     languages — lets TEXT-ONLY models "read" the screen
 *
 * PowerShell is invoked with -EncodedCommand (no quoting/injection surface).
 * Privacy: screenshots are a sensitive read — the tool layer puts them
 * behind the standard confirmation flow.
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
const PS_CAPTURE = `
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
$out = [ordered]@{
  b64 = [Convert]::ToBase64String($ms.ToArray());
  w = $vs.Width; h = $vs.Height; left = $vs.Left; top = $vs.Top;
};
$g.Dispose(); $bmp.Dispose(); $ms.Dispose();
[Console]::Out.Write((ConvertTo-Json -Compress $out));
`;
function encodeCommand(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}
function runPowerShell(script, env = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('screen capture timed out'));
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve(stdout);
            else
                reject(new Error(stderr.trim().substring(0, 300) || `PowerShell exited ${code}`));
        });
    });
}
/** Captures the virtual screen (all monitors) as JPEG. */
export async function captureScreen(quality = 70) {
    const out = await runPowerShell(PS_CAPTURE, { GCA_JPEG_QUALITY: String(quality) }, 20000);
    const parsed = JSON.parse(out.trim());
    if (!parsed.b64 || parsed.b64.length < 100) {
        throw new Error('capture returned empty image (session locked or no desktop access?)');
    }
    logger.info('Screen captured', { width: parsed.w, height: parsed.h, bytes: parsed.b64.length });
    return {
        jpegBase64: parsed.b64,
        width: parsed.w,
        height: parsed.h,
        left: parsed.left,
        top: parsed.top,
        capturedAt: new Date().toISOString(),
    };
}
const PS_OCR = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$ms = New-Object System.IO.MemoryStream (,[Convert]::FromBase64String($env:GCA_IMG_B64));
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
if ($null -eq $engine) { [Console]::Out.Write(''); exit 0; }
$stream = $ms.AsRandomAccessStream();
$decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult();
$bmp = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult();
$result = $engine.RecognizeAsync($bmp).GetAwaiter().GetResult();
[Console]::Out.Write($result.Text);
`;
/** Best-effort OCR via built-in WinRT. Returns '' when unavailable/failed. */
export async function ocrImage(jpegBase64) {
    try {
        const text = await runPowerShell(PS_OCR, { GCA_IMG_B64: jpegBase64 }, 30000);
        logger.info('OCR completed', { chars: text.trim().length });
        return text.trim();
    }
    catch (err) {
        logger.warn('OCR unavailable, continuing without text', {
            error: err instanceof Error ? err.message : String(err),
        });
        return '';
    }
}
// --- Android screen capture via screencap ---
/**
 * Captures the Android screen via AccessibilityService.takeScreenshot().
 *
 * Flow:
 *   1. Write request file to {homedir}/.gca-screenshots/request
 *   2. GcaService's screenshot watcher detects it → calls AccessibilityService
 *   3. AccessibilityService.takeScreenshot() → saves PNG to result.png
 *   4. We poll for result.png, read it, clean up
 *
 * Prerequisite: user must enable GCA in Settings → Accessibility once.
 * After that, screenshots work without any permission dialogs.
 *
 * Timeout: 30s.
 */
export async function captureScreenAndroid(quality) {
    const tmpDir = path.join(os.homedir(), '.gca-screenshots');
    await mkdir(tmpDir, { recursive: true });
    const requestFile = path.join(tmpDir, 'request');
    const resultFile = path.join(tmpDir, 'result.png');
    // Clean up any stale files from previous runs
    try {
        await unlink(resultFile);
    }
    catch { }
    try {
        await unlink(requestFile);
    }
    catch { }
    // Write request file — Kotlin watcher picks this up
    await writeFile(requestFile, Date.now().toString(), 'utf8');
    logger.info('Android screenshot request sent, waiting for MediaProjection capture...');
    // Poll for result file (max 30 seconds — user needs time to accept permission dialog)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        // Check for error file first
        try {
            const errMsg = await readFile(resultFile.replace('.png', '.error'), 'utf8');
            if (errMsg) {
                try {
                    await unlink(resultFile.replace('.png', '.error'));
                }
                catch { }
                throw new Error(`Android screenshot failed: ${errMsg}`);
            }
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('Android screenshot failed'))
                throw err;
            // No error file — continue
        }
        try {
            const pngBuf = await readFile(resultFile);
            if (pngBuf.length > 100) {
                const b64 = pngBuf.toString('base64');
                const width = pngBuf.readUInt32BE(16);
                const height = pngBuf.readUInt32BE(20);
                // Save a copy to a known path so the AI can reference it via file_serve
                const savedPath = path.join(tmpDir, 'latest.png');
                await writeFile(savedPath, pngBuf);
                await unlink(resultFile); // clean up bridge file
                logger.info('Android screen captured', { width, height, pngBytes: pngBuf.length, savedPath });
                return {
                    jpegBase64: b64,
                    width,
                    height,
                    left: 0,
                    top: 0,
                    capturedAt: new Date().toISOString(),
                    savedPath, // AI can use this path for file_serve
                };
            }
        }
        catch {
            // File not ready yet
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Screenshot timed out (30s). Ensure Accessibility Service is enabled: ' +
        'Settings → Accessibility → GCA Screen Capture. ' +
        'Once enabled, screenshots work without any permission dialogs.');
}
//# sourceMappingURL=screen-capture.js.map