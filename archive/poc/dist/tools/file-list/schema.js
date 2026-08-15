/**
 * Zod schema for the file_list tool input.
 * Validates the directory path and optional glob filter / recursion flag.
 */
import { z } from 'zod';
export const fileListInputSchema = {
    path: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute path of the directory to list'),
    pattern: z
        .string()
        .max(256)
        .optional()
        .describe('Wildcard filter on entry names, e.g. "*.pdf". Supports * and ?. Applies to both files and directories.'),
    recursive: z
        .boolean()
        .optional()
        .describe('Recurse into subdirectories. Default false. Hard caps: depth 8, 2000 entries.'),
};
//# sourceMappingURL=schema.js.map