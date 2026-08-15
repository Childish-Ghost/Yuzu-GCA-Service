/**
 * Zod schema for the file_read tool input.
 * Reads a text file with an optional 1-based line range.
 */
import { z } from 'zod';
export const fileReadInputSchema = {
    path: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute path of the file to read'),
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to return (1-based, inclusive). Default 1.'),
    endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Last line to return (1-based, inclusive). Default: end of file, capped at 4000 lines per call.'),
};
//# sourceMappingURL=schema.js.map