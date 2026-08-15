/**
 * exec_background Tool Handler - starts long commands without blocking.
 *
 * Same three-level approval as exec:
 *   - readonly commands start immediately, returning a taskId + logPath
 *   - write commands return a confirmToken (confirm tool starts the task)
 *   - dangerous commands are blocked
 *
 * Output goes to %TEMP%/gca-task-<id>.log — read it with file_read;
 * check liveness with process_list (filter by pid).
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { ExecBackgroundInput } from './schema.js';
export declare function execBackgroundHandler(args: ExecBackgroundInput): Promise<{
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
