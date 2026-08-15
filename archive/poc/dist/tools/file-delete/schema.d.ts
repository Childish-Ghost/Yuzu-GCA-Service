/**
 * Zod schema for the file_delete tool input.
 * Deletes a file or directory (requires user confirmation).
 */
import { z } from 'zod';
export declare const fileDeleteInputSchema: {
    path: z.ZodString;
    recursive: z.ZodOptional<z.ZodBoolean>;
};
export type FileDeleteInput = z.infer<ReturnType<typeof z.object<typeof fileDeleteInputSchema>>>;
