/**
 * Zod schema for the input_consent tool.
 * Grants a time-boxed window for remote_input without per-action confirmation.
 */
import { z } from 'zod';
export declare const inputConsentInputSchema: {
    minutes: z.ZodNumber;
};
export type InputConsentInput = z.infer<ReturnType<typeof z.object<typeof inputConsentInputSchema>>>;
