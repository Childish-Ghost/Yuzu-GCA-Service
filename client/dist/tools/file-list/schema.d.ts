/**
 * Zod schema for the file_list tool input.
 * Validates the directory path and optional glob filter / recursion flag.
 */
import { z } from 'zod';
export declare const fileListInputSchema: {
    path: z.ZodString;
    pattern: z.ZodOptional<z.ZodString>;
    recursive: z.ZodOptional<z.ZodBoolean>;
};
export type FileListInput = z.infer<ReturnType<typeof z.object<typeof fileListInputSchema>>>;
