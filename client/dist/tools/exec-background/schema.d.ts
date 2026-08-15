/**
 * Zod schema for the exec_background tool input.
 * Starts a long-running command in the background, output to a log file.
 */
import { z } from 'zod';
export declare const execBackgroundInputSchema: {
    command: z.ZodString;
};
export type ExecBackgroundInput = z.infer<ReturnType<typeof z.object<typeof execBackgroundInputSchema>>>;
