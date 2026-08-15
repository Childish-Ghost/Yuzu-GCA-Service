/**
 * file_list Tool Handler - lists directory contents with optional glob filter.
 *
 * Read-only operation, no approval required (same level as `dir`/`ls`
 * which are on the exec readonly whitelist).
 *
 * Safety caps:
 *   - Max 2000 entries returned (truncated flag set when hit)
 *   - Max recursion depth 8
 *   - Unreadable directories are skipped, never fatal
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { FileEntry } from '../../types/tools.js';
import type { FileListInput } from './schema.js';
export declare const FILE_LIST_MAX_ENTRIES = 2000;
export declare const FILE_LIST_MAX_DEPTH = 8;
export type { FileEntry };
/**
 * Converts a shell-style wildcard pattern (* and ?) into an anchored RegExp.
 * Matching is case-insensitive on Windows, case-sensitive elsewhere.
 */
export declare function wildcardToRegex(pattern: string): RegExp;
export declare function fileListHandler(args: FileListInput): Promise<{
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
