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
export interface ScreenCaptureResult {
    jpegBase64: string;
    width: number;
    height: number;
    left: number;
    top: number;
    capturedAt: string;
    savedPath?: string;
}
/** Captures the virtual screen (all monitors) as JPEG. */
export declare function captureScreen(quality?: number): Promise<ScreenCaptureResult>;
/** Best-effort OCR via built-in WinRT. Returns '' when unavailable/failed. */
export declare function ocrImage(jpegBase64: string): Promise<string>;
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
export declare function captureScreenAndroid(quality: number): Promise<ScreenCaptureResult>;
