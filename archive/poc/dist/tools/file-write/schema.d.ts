/**
 * Zod schema for the file_write tool input.
 * Writes or appends text content to a file (requires user confirmation).
 */
import { z } from 'zod';
export declare const fileWriteInputSchema: {
    path: z.ZodString;
    content: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<["overwrite", "append"]>>;
    createDirs: z.ZodOptional<z.ZodBoolean>;
};
export type FileWriteInput = z.infer<ReturnType<typeof z.object<typeof fileWriteInputSchema>>>;
