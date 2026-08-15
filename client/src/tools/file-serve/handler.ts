/**
 * file_serve Tool Handler - queues a file publication for confirmation.
 *
 * Publishing a file to the network (even single-use + short TTL) is a
 * security-sensitive action, so it goes through the confirm flow like any
 * write operation: the ticket is only minted after the user confirms.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createPending } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
import type { WriteOpConfirmationRequiredResult } from '../../types/tools.js';
import type { FileServeInput } from './schema.js';

export const FILE_SERVE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB cap

function errorResult(error: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', error }, null, 2),
      },
    ],
    isError: true,
  };
}

export async function fileServeHandler(args: FileServeInput) {
  const { path: filePath } = args;

  logger.info('file_serve tool called', { path: filePath });

  const abs = path.resolve(filePath);
  let fileStat;
  try {
    fileStat = await stat(abs);
  } catch {
    return errorResult(`Path does not exist or is not accessible: ${abs}`);
  }
  if (!fileStat.isFile()) {
    return errorResult(`Path is not a regular file: ${abs}`);
  }
  if (fileStat.size > FILE_SERVE_MAX_BYTES) {
    return errorResult(`File too large (${fileStat.size} bytes, cap is ${FILE_SERVE_MAX_BYTES})`);
  }

  createPending({
    operation: { kind: 'file_serve', path: abs },
    reason: `file_serve ${abs} (${fileStat.size} bytes)`,
  });

  const body: WriteOpConfirmationRequiredResult = {
    status: 'confirmation_required',
    operation: 'file_serve',
    reason: `Publish ${abs} (${fileStat.size} bytes) for a single one-shot download by another device (ticket expires in 5 minutes). Nothing is exposed yet.`,
    executed: false,
    expiresInSec: 300,
    note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
