/**
 * service Tool Handler - system service inspection and control.
 *
 *   - list               → read-only, auto-approved
 *   - start/stop/restart → OTP flow (verification code shown on the device
 *                          screen, never to the AI), confirm executes
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { ServiceInput } from './schema.js';
export declare function serviceHandler(args: ServiceInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
}>;
