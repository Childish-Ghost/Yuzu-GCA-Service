/**
 * exec Tool Handler - the controller layer for command execution.
 *
 * Flow:
 *   1. Validate input (done by Zod schema at registration time)
 *   2. Evaluate command against three-level approval policy
 *   3. If approved: execute and return result
 *   4. If confirmation_required: return structured response (POC: no execution)
 *   5. If blocked: return error with reason, log to security audit
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import type { ExecInput } from './schema.js';
export declare function execHandler(args: ExecInput): Promise<{
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
