/**
 * confirm Tool Handler - executes an operation the user has confirmed.
 *
 * Single confirmation entry point for every write operation:
 *   - exec        → re-evaluate (defense in depth), then run the command
 *   - file_write  → write/append the file
 *   - file_move   → rename source to dest
 *
 * Flow: consume the single-use token → dispatch by operation kind → execute.
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { ConfirmInput } from './schema.js';
export declare function confirmHandler(args: ConfirmInput): Promise<{
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
} | {
    content: {
        type: "text";
        text: string;
    }[];
}>;
