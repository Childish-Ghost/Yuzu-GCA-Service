/**
 * Zod schema for the file_read tool input.
 * Reads a text file with an optional 1-based line range.
 */
import { z } from 'zod';
export declare const fileReadInputSchema: {
    path: z.ZodString;
    startLine: z.ZodOptional<z.ZodNumber>;
    endLine: z.ZodOptional<z.ZodNumber>;
};
export type FileReadInput = z.infer<ReturnType<typeof z.object<typeof fileReadInputSchema>>>;
