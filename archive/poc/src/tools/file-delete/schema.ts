/**
 * Zod schema for the file_delete tool input.
 * Deletes a file or directory (requires user confirmation).
 */

import { z } from 'zod';

export const fileDeleteInputSchema = {
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe('Absolute path of the file or directory to delete'),
  recursive: z
    .boolean()
    .optional()
    .describe('Required (true) when deleting a non-empty directory. Default false.'),
};

export type FileDeleteInput = z.infer<ReturnType<typeof z.object<typeof fileDeleteInputSchema>>>;
