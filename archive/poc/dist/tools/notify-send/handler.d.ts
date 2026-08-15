/**
 * notify_send Tool Handler - pops a desktop notification on this device.
 *
 * Useful for the AI to reach the human at the keyboard — status updates,
 * "your task finished", or a heads-up before a disruptive action.
 *
 * Read-only-ish (no system state change), auto-approved.
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { NotifySendInput } from './schema.js';
export declare function notifySendHandler(args: NotifySendInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
