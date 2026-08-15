/**
 * power Tool Handler - system power control with OTP verification.
 *
 * High-risk policy (security.md: shutdown/reboot must go through this tool):
 *   - shutdown / restart / sleep / hibernate → OTP flow: a verification code
 *     pops up on THIS DEVICE's screen (out of band, the AI never sees it);
 *     the user types the code in chat; confirm executes.
 *   - wol (harmless outbound packet) → normal chat-token confirmation.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { PowerInput } from './schema.js';
export declare function powerHandler(args: PowerInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError?: undefined;
} | {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
}>;
