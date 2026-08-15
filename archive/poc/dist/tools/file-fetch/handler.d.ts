/**
 * file_fetch Tool Handler - queues a cross-device download for confirmation.
 *
 * Writing a downloaded file to disk is a write operation: the download only
 * runs after the user confirms (same flow as file_write).
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileFetchInput } from './schema.js';
export declare function fileFetchHandler(args: FileFetchInput): Promise<{
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
