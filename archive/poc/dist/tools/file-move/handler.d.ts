/**
 * file_move Tool Handler - queues a move/rename for user confirmation.
 *
 * Write operations NEVER execute inline (security.md level 2): this handler
 * mints a confirmToken; the confirmed move runs through the confirm tool.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileMoveInput } from './schema.js';
export declare function fileMoveHandler(args: FileMoveInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
