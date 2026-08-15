/**
 * process_list Tool Handler - lists running processes.
 *
 * Read-only operation, no approval required (same level as `ps`/`tasklist`
 * which are on the exec readonly whitelist).
 *
 * Implementation: fixed platform commands parsed in JS — the user-supplied
 * filter is applied AFTER parsing, never interpolated into the command line,
 * so there is no injection surface.
 *   - Windows: PowerShell Get-Process (CPU seconds + working set)
 *   - Linux/macOS: ps with cumulative CPU time and RSS
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { ProcessListInput } from './schema.js';
export declare function processListHandler(args: ProcessListInput): Promise<{
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
