/**
 * screenshot Tool Handler (R-001) - captures the screen for the AI.
 *
 * Privacy model (user-approved design #3):
 *   - Inside an active consent window (screen_consent) → capture immediately
 *   - Outside → confirmation_required; the capture happens only after the
 *     user confirms (bare confirm)
 *
 * Returns dual payload: MCP image block (JPEG) + WinRT OCR text.
 */
import type { ScreenshotInput } from './schema.js';
export declare function screenshotHandler(args: ScreenshotInput): Promise<{
    content: ({
        type: "text";
        text: string;
        data?: undefined;
        mimeType?: undefined;
    } | {
        type: "image";
        data: string;
        mimeType: "image/jpeg" | "image/png";
        text?: undefined;
    })[];
}>;
/** Executes the capture (consent-window path or confirm dispatcher). */
export declare function executeScreenshot(quality: number, ocr: boolean, confirmedByUser?: boolean): Promise<{
    content: ({
        type: "text";
        text: string;
        data?: undefined;
        mimeType?: undefined;
    } | {
        type: "image";
        data: string;
        mimeType: "image/jpeg" | "image/png";
        text?: undefined;
    })[];
}>;
