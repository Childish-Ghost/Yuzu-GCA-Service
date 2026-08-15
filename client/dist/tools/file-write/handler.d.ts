/**
 * file_write Tool Handler - queues a file write for user confirmation.
 *
 * Write operations NEVER execute inline (same policy as exec write commands,
 * security.md level 2): this handler mints a confirmToken via the pending
 * approvals store; the confirmed write runs through the confirm tool.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileWriteInput } from './schema.js';
export declare function fileWriteHandler(args: FileWriteInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
