/**
 * input_consent Tool Handler - manages the remote_input permission window.
 * Same pattern as screen_consent but for keyboard/mouse control.
 */
import type { InputConsentInput } from './schema.js';
export declare function inputConsentHandler(args: InputConsentInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
