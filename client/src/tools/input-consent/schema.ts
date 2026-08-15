/**
 * Zod schema for the input_consent tool.
 * Grants a time-boxed window for remote_input without per-action confirmation.
 */

import { z } from 'zod';

export const inputConsentInputSchema = {
  minutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .describe('Window duration in minutes (0 = revoke immediately). Max 120.'),
};

export type InputConsentInput = z.infer<ReturnType<typeof z.object<typeof inputConsentInputSchema>>>;
