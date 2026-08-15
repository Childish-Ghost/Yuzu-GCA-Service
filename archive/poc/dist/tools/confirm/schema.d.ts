/**
 * Zod schema for the confirm tool input.
 * Token is OPTIONAL: omitting it confirms the most recent pending write
 * operation (exec/file_*). Codes are only required for power/service.
 */
import { z } from 'zod';
export declare const confirmInputSchema: {
    token: z.ZodOptional<z.ZodString>;
};
export type ConfirmInput = z.infer<ReturnType<typeof z.object<typeof confirmInputSchema>>>;
