/**
 * Zod schema for the exec_background tool input.
 * Starts a long-running command in the background, output to a log file.
 */
import { z } from 'zod';
export const execBackgroundInputSchema = {
    command: z
        .string()
        .min(1)
        .max(4096)
        .describe('The shell command to run in the background'),
};
//# sourceMappingURL=schema.js.map