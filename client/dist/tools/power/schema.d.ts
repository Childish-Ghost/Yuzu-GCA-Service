/**
 * Zod schema for the power tool input.
 * Shutdown / restart / sleep / hibernate / Wake-on-LAN.
 * System power actions require OTP verification (code shown on the device).
 */
import { z } from 'zod';
export declare const powerInputSchema: {
    action: z.ZodEnum<["shutdown", "restart", "sleep", "hibernate", "wol", "abort"]>;
    delaySec: z.ZodOptional<z.ZodNumber>;
    mac: z.ZodOptional<z.ZodString>;
};
export type PowerInput = z.infer<ReturnType<typeof z.object<typeof powerInputSchema>>>;
