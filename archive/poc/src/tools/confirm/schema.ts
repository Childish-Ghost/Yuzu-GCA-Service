/**
 * Zod schema for the confirm tool input.
 * Token is OPTIONAL: omitting it confirms the most recent pending write
 * operation (exec/file_*). Codes are only required for power/service.
 */

import { z } from 'zod';

export const confirmInputSchema = {
  token: z
    .string()
    .max(64)
    .optional()
    .describe('Omit to confirm the most recent pending operation. Or pass: the confirmToken from a confirmation_required response / the 3-digit push nonce / the 6-digit authenticator code (power/service).'),
};

export type ConfirmInput = z.infer<ReturnType<typeof z.object<typeof confirmInputSchema>>>;
