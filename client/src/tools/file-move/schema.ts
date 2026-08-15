/**
 * Zod schema for the file_move tool input.
 * Moves/renames a file or directory (requires user confirmation).
 */

import { z } from 'zod';

export const fileMoveInputSchema = {
  source: z
    .string()
    .min(1)
    .max(1024)
    .describe('Absolute path of the file or directory to move'),
  dest: z
    .string()
    .min(1)
    .max(1024)
    .describe('Destination absolute path'),
};

export type FileMoveInput = z.infer<ReturnType<typeof z.object<typeof fileMoveInputSchema>>>;
