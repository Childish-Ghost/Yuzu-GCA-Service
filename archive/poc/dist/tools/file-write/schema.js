/**
 * Zod schema for the file_write tool input.
 * Writes or appends text content to a file (requires user confirmation).
 */
import { z } from 'zod';
export const fileWriteInputSchema = {
    path: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute path of the file to write'),
    content: z
        .string()
        .max(1048576)
        .describe('Text content to write (max 1MB)'),
    mode: z
        .enum(['overwrite', 'append'])
        .optional()
        .describe('overwrite (default) replaces the file; append adds to the end'),
    createDirs: z
        .boolean()
        .optional()
        .describe('Create parent directories if missing. Default false.'),
};
//# sourceMappingURL=schema.js.map