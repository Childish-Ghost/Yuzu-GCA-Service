/**
 * Zod schema for the file_move tool input.
 * Moves/renames a file or directory (requires user confirmation).
 */
import { z } from 'zod';
export declare const fileMoveInputSchema: {
    source: z.ZodString;
    dest: z.ZodString;
};
export type FileMoveInput = z.infer<ReturnType<typeof z.object<typeof fileMoveInputSchema>>>;
