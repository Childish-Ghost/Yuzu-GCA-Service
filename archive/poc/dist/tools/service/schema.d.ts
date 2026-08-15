/**
 * Zod schema for the service tool input.
 * Lists system services (read-only) or controls them (OTP required).
 */
import { z } from 'zod';
export declare const serviceInputSchema: {
    action: z.ZodEnum<["list", "start", "stop", "restart"]>;
    name: z.ZodOptional<z.ZodString>;
    filter: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
};
export type ServiceInput = z.infer<ReturnType<typeof z.object<typeof serviceInputSchema>>>;
