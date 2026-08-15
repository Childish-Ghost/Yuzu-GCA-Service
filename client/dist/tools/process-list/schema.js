/**
 * Zod schema for the process_list tool input.
 * Lists running processes with sorting and an optional name filter.
 */
import { z } from 'zod';
export const processListInputSchema = {
    sortBy: z
        .enum(['cpu', 'memory', 'pid', 'name'])
        .optional()
        .describe('Sort field: cpu (default), memory, pid, or name'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max processes to return. Default 20, max 100.'),
    filter: z
        .string()
        .max(128)
        .optional()
        .describe('Case-insensitive substring filter on process names'),
};
//# sourceMappingURL=schema.js.map