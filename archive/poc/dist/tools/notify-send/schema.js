/**
 * Zod schema for the notify_send tool input.
 * Sends a desktop notification to the device owner.
 */
import { z } from 'zod';
export const notifySendInputSchema = {
    message: z
        .string()
        .min(1)
        .max(500)
        .describe('Notification text shown to the device owner'),
    title: z
        .string()
        .max(80)
        .optional()
        .describe('Notification title. Default "GCA"'),
};
//# sourceMappingURL=schema.js.map