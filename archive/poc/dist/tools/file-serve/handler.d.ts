/**
 * file_serve Tool Handler - queues a file publication for confirmation.
 *
 * Publishing a file to the network (even single-use + short TTL) is a
 * security-sensitive action, so it goes through the confirm flow like any
 * write operation: the ticket is only minted after the user confirms.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileServeInput } from './schema.js';
export declare const FILE_SERVE_MAX_BYTES: number;
export declare function fileServeHandler(args: FileServeInput): Promise<{
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
