/**
 * Zod schema for the screen_consent tool input.
 * Grants or revokes a time-boxed screenshot permission window.
 */
import { z } from 'zod';
export declare const screenConsentInputSchema: {
    minutes: z.ZodNumber;
};
export type ScreenConsentInput = z.infer<ReturnType<typeof z.object<typeof screenConsentInputSchema>>>;
