/**
 * Zod schema for the service tool input.
 * Lists system services (read-only) or controls them (OTP required).
 */
import { z } from 'zod';
export const serviceInputSchema = {
    action: z
        .enum(['list', 'start', 'stop', 'restart'])
        .describe('list (read-only, auto-approved) or start/stop/restart (OTP verification required)'),
    name: z
        .string()
        .max(128)
        .optional()
        .describe('Service name for start/stop/restart, e.g. "wuauserv"'),
    filter: z
        .string()
        .max(128)
        .optional()
        .describe('Substring filter for list (matches name and display name)'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max services to return for list. Default 50.'),
};
//# sourceMappingURL=schema.js.map