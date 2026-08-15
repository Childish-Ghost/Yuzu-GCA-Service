/**
 * Zod schema for the confirm tool input.
 * Token is OPTIONAL: omitting it confirms the most recent pending write
 * operation (exec/file_*). Power/service/registration approvals go through
 * gca-server approve_op, not this tool.
 */

import { z } from 'zod';

export const confirmInputSchema = {
  token: z
    .string()
    .max(64)
    .optional()
    .describe('Omit to confirm the most recent pending operation. Or pass the confirmToken from a confirmation_required response.'),
};

export type ConfirmInput = z.infer<ReturnType<typeof z.object<typeof confirmInputSchema>>>;
