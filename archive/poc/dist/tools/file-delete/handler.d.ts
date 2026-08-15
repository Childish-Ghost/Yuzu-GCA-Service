/**
 * file_delete Tool Handler - queues a delete for user confirmation.
 *
 * Write operations NEVER execute inline (security.md level 2, del/rm):
 * this handler mints a confirmToken; the confirmed delete runs through
 * the confirm tool.
 *
 * Guard rails evaluated at execution time (in confirm):
 *   - refuses to delete filesystem roots (C:\, /, D:\ ...)
 *   - non-empty directories require recursive: true
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileDeleteInput } from './schema.js';
export declare function fileDeleteHandler(args: FileDeleteInput): Promise<{
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
    isError?: undefined;
}>;
