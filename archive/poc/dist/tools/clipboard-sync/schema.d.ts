/**
 * Zod schema for the clipboard_sync tool.
 * Read or write the system clipboard.
 */
import { z } from 'zod';
export declare const clipboardSyncInputSchema: {
    action: z.ZodEnum<["get", "set"]>;
    text: z.ZodOptional<z.ZodString>;
};
export type ClipboardSyncInput = z.infer<ReturnType<typeof z.object<typeof clipboardSyncInputSchema>>>;
