/**
 * Zod schema for the notify_send tool input.
 * Sends a desktop notification to the device owner.
 */
import { z } from 'zod';
export declare const notifySendInputSchema: {
    message: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
};
export type NotifySendInput = z.infer<ReturnType<typeof z.object<typeof notifySendInputSchema>>>;
