/**
 * file_read Tool Handler - reads a text file with optional line range.
 *
 * Read-only operation, no approval required (same level as `cat`/`type`
 * which are on the exec readonly whitelist).
 *
 * Safety caps:
 *   - Files larger than 64MB are refused
 *   - Binary files (NUL byte in first 8KB) are refused
 *   - At most 4000 lines / 512KB of content per call (truncated flag set)
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileReadInput } from './schema.js';
export declare function fileReadHandler(args: FileReadInput): Promise<{
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
