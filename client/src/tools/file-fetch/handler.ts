/**
 * file_fetch Tool Handler - queues a cross-device download for confirmation.
 *
 * Writing a downloaded file to disk is a write operation: the download only
 * runs after the user confirms (same flow as file_write).
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import path from 'node:path';
import { createPending } from '../../services/pending-approvals.js';
import { downloadFile, isTransferTicketUrl } from '../../services/transfer-fetch.js';
import { audit } from '../../services/audit-client.js';
import { logger } from '../../utils/logger.js';
import type { FileFetchOkResult, WriteOpConfirmationRequiredResult } from '../../types/tools.js';
import type { FileFetchInput } from './schema.js';

function errorResult(error: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error }, null, 2) }],
    isError: true,
  };
}

export async function fileFetchHandler(args: FileFetchInput) {
  const { url, targetPath } = args;

  logger.info('file_fetch tool called', { url: url.substring(0, 80), targetPath });

  // Basic URL hygiene: http only (https later), no file:// tricks
  if (!/^http:\/\//i.test(url)) {
    return errorResult('Only http:// transfer URLs are supported');
  }

  const absTarget = path.resolve(targetPath);

  // --- Ticket URLs execute immediately: the ticket itself IS the user's
  // authorization (they already confirmed file_serve on the source side —
  // one confirmation per transfer, not two).
  if (await isTransferTicketUrl(url)) {
    try {
      const outcome = await downloadFile(url, absTarget);
      const body: FileFetchOkResult = {
        status: 'fetched',
        url,
        targetPath: absTarget,
        bytes: outcome.bytes,
        sizeMatches: outcome.sizeMatches,
      };
      logger.info('file_fetch completed (ticket-authorized)', { targetPath: absTarget, bytes: outcome.bytes });
      // 免确认传输（INT-005）
      void audit({ action: 'file_fetch', detail: url, status: 'fetched' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('file_fetch failed', { url: url.substring(0, 60), error: errorMessage });
      return errorResult(errorMessage);
    }
  }

  // --- Foreign URLs need explicit confirmation (arbitrary write to disk)
  createPending({
    operation: { kind: 'file_fetch', url, targetPath: absTarget },
    reason: `file_fetch ${url.substring(0, 80)} -> ${absTarget}`,
  });

  const body: WriteOpConfirmationRequiredResult = {
    status: 'confirmation_required',
    operation: 'file_fetch',
    reason: `Download a file from another device to ${absTarget}. Nothing has been downloaded yet.`,
    executed: false,
    expiresInSec: 300,
    note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
