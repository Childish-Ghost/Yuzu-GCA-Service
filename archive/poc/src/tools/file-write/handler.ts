/**
 * file_write Tool Handler - queues a file write for user confirmation.
 *
 * Write operations NEVER execute inline (same policy as exec write commands,
 * security.md level 2): this handler mints a confirmToken via the pending
 * approvals store; the confirmed write runs through the confirm tool.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import path from 'node:path';
import { createPending } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
import type { WriteOpConfirmationRequiredResult } from '../../types/tools.js';
import type { FileWriteInput } from './schema.js';

export async function fileWriteHandler(args: FileWriteInput) {
  const { path: filePath, content, mode = 'overwrite', createDirs = false } = args;

  logger.info('file_write tool called', { path: filePath, mode, createDirs, chars: content.length });

  const abs = path.resolve(filePath);
  createPending({
    operation: { kind: 'file_write', path: abs, content, mode, createDirs },
    reason: `file_write ${mode} ${abs} (${content.length} chars)`,
  });

  const body: WriteOpConfirmationRequiredResult = {
    status: 'confirmation_required',
    operation: 'file_write',
    reason: `Write ${content.length} characters to ${abs} (mode: ${mode}${createDirs ? ', create parent dirs' : ''}). Nothing has been written yet.`,
    executed: false,
    expiresInSec: 300,
    note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
