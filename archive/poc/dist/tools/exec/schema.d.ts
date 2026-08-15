/**
 * Zod schema for the exec tool input.
 * Validates the command string and optional working directory.
 */
import { z } from 'zod';
export declare const execInputSchema: {
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    timeout: z.ZodOptional<z.ZodNumber>;
};
export type ExecInput = z.infer<ReturnType<typeof z.object<typeof execInputSchema>>>;
