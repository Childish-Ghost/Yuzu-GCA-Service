/**
 * Zod schema for the exec tool input.
 * Validates the command string and optional working directory.
 */
import { z } from 'zod';
export const execInputSchema = {
    command: z
        .string()
        .min(1)
        .max(4096)
        .describe('The shell command to execute on this device'),
    cwd: z
        .string()
        .optional()
        .describe('Working directory for the command. Defaults to the process cwd.'),
    timeout: z
        .number()
        .int()
        .positive()
        .max(300000)
        .optional()
        .describe('Timeout in milliseconds. Max 300000 (5 min). Default 30000 (30s).'),
};
//# sourceMappingURL=schema.js.map