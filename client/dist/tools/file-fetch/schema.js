/**
 * Zod schema for the file_fetch tool input.
 * Downloads a file from another device's one-shot transfer URL.
 */
import { z } from 'zod';
export const fileFetchInputSchema = {
    url: z
        .string()
        .min(1)
        .max(2048)
        .describe('The one-shot transfer URL returned by file_serve on the source device (contains the ticket token)'),
    targetPath: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute path where the downloaded file will be written on this device'),
};
//# sourceMappingURL=schema.js.map