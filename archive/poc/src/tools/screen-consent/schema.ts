/**
 * Zod schema for the screen_consent tool input.
 * Grants or revokes a time-boxed screenshot permission window.
 */

import { z } from 'zod';

export const screenConsentInputSchema = {
  minutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .describe('Consent window length in minutes (max 120). 0 = revoke immediately.'),
};

export type ScreenConsentInput = z.infer<ReturnType<typeof z.object<typeof screenConsentInputSchema>>>;
