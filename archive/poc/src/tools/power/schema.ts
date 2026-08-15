/**
 * Zod schema for the power tool input.
 * Shutdown / restart / sleep / hibernate / Wake-on-LAN.
 * System power actions require OTP verification (code shown on the device).
 */

import { z } from 'zod';

export const powerInputSchema = {
  action: z
    .enum(['shutdown', 'restart', 'sleep', 'hibernate', 'wol', 'abort'])
    .describe('Power action to perform. abort cancels a scheduled shutdown/restart (auto-approved).'),
  delaySec: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional()
    .describe('Delay before shutdown/restart in seconds. Default 30; floored at 30 to always leave an abort window (abort action cancels).'),
  mac: z
    .string()
    .max(17)
    .optional()
    .describe('Target MAC address for wol, e.g. "AA:BB:CC:DD:EE:FF"'),
};

export type PowerInput = z.infer<ReturnType<typeof z.object<typeof powerInputSchema>>>;
