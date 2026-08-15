/**
 * Zod schema for the file_serve tool input.
 * Publishes one file for a single one-shot cross-device download.
 */
import { z } from 'zod';
export declare const fileServeInputSchema: {
    path: z.ZodString;
};
export type FileServeInput = z.infer<ReturnType<typeof z.object<typeof fileServeInputSchema>>>;
