/**
 * Zod schema for the clipboard_sync tool.
 * Read or write the system clipboard.
 */
import { z } from 'zod';
export const clipboardSyncInputSchema = {
    action: z
        .enum(['get', 'set'])
        .describe('get: return current clipboard text. set: write text to clipboard.'),
    text: z
        .string()
        .max(10240)
        .optional()
        .describe('Text to write (set action only). Max 10240 chars.'),
};
//# sourceMappingURL=schema.js.map