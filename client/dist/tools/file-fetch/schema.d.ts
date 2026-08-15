/**
 * Zod schema for the file_fetch tool input.
 * Downloads a file from another device's one-shot transfer URL.
 */
import { z } from 'zod';
export declare const fileFetchInputSchema: {
    url: z.ZodString;
    targetPath: z.ZodString;
};
export type FileFetchInput = z.infer<ReturnType<typeof z.object<typeof fileFetchInputSchema>>>;
