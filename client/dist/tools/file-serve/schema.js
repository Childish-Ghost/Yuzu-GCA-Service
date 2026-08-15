/**
 * Zod schema for the file_serve tool input.
 * Publishes one file for a single one-shot cross-device download.
 */
import { z } from 'zod';
export const fileServeInputSchema = {
    path: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute path of the file to publish for transfer'),
};
//# sourceMappingURL=schema.js.map