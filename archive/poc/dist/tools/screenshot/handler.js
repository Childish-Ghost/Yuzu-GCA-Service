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
import os from 'node:os';
import { createPending } from '../../services/pending-approvals.js';
import { hasConsent } from '../../services/screen-consent.js';
import { captureScreen, captureScreenAndroid, ocrImage } from '../../services/screen-capture.js';
import { logger } from '../../utils/logger.js';
const isAndroid = os.platform() === 'android';
export async function screenshotHandler(args) {
    const { quality = 70, ocr = true } = args;
    logger.info('screenshot tool called', { quality, ocr, platform: os.platform() });
    // Inside an active consent window: capture right away
    if (await hasConsent()) {
        return executeScreenshot(quality, ocr, false);
    }
    createPending({
        operation: { kind: 'screenshot', quality, ocr },
        reason: `screenshot (quality ${quality}, ocr ${ocr})`,
    });
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    status: 'confirmation_required',
                    operation: 'screenshot',
                    reason: 'Capture a screenshot of everything currently visible on this device\'s screen (privacy-sensitive). Nothing has been captured yet. Tip: the screen_consent tool can open a timed window that skips per-shot confirmation.',
                    executed: false,
                    expiresInSec: 300,
                    note: 'Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} as arguments (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.',
                }, null, 2),
            },
        ],
    };
}
/** Executes the capture (consent-window path or confirm dispatcher). */
export async function executeScreenshot(quality, ocr, confirmedByUser = true) {
    const capture = isAndroid
        ? await captureScreenAndroid(quality)
        : await captureScreen(quality);
    const ocrText = ocr && !isAndroid ? await ocrImage(capture.jpegBase64) : '';
    const mimeType = isAndroid ? 'image/png' : 'image/jpeg';
    const meta = {
        status: 'captured',
        width: capture.width,
        height: capture.height,
        capturedAt: capture.capturedAt,
        imageBytes: Math.round((capture.jpegBase64.length * 3) / 4),
        format: mimeType,
        ocrText: ocrText || null,
        confirmedByUser,
        ...(capture.savedPath ? { savedPath: capture.savedPath } : {}),
    };
    logger.info('screenshot executed', { width: capture.width, height: capture.height, format: mimeType, ocrChars: ocrText.length });
    return {
        content: [
            { type: 'text', text: JSON.stringify(meta, null, 2) },
            {
                type: 'image',
                data: capture.jpegBase64,
                mimeType: mimeType,
            },
        ],
    };
}
//# sourceMappingURL=handler.js.map