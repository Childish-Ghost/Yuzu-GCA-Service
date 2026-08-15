/**
 * screen_consent Tool Handler - manages the screenshot permission window.
 *
 * Granting a window (minutes > 0) lowers the privacy bar for a while, so it
 * always goes through the confirmation flow. Revoking (minutes = 0) raises
 * it back — that is free and instant.
 */
import type { ScreenConsentInput } from './schema.js';
export declare function screenConsentHandler(args: ScreenConsentInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
