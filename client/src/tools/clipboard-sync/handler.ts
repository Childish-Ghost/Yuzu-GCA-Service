/**
 * clipboard_sync Tool Handler (R-003) - read/write the system clipboard.
 *
 * Both actions are privacy-sensitive (clipboard may contain passwords),
 * so they go through the standard confirmation flow.
 */

import { createPending } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
import type { ClipboardSyncInput } from './schema.js';

export async function clipboardSyncHandler(args: ClipboardSyncInput) {
  const { action, text } = args;

  logger.info('clipboard_sync tool called', { action, textLen: text?.length });

  if (action === 'set' && !text) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', error: 'set action requires text' }, null, 2),
        },
      ],
      isError: true,
    };
  }

  createPending({
    operation: { kind: 'clipboard_sync', action, text: text ?? '' },
    reason: `clipboard_sync ${action}`,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'confirmation_required',
          operation: 'clipboard_sync',
          reason: `${action === 'get' ? 'Read' : 'Write'} the system clipboard on this device (may contain sensitive data). Nothing has been executed yet.`,
          executed: false,
          expiresInSec: 300,
          note: 'Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.',
        }, null, 2),
      },
    ],
  };
}

/** Executes the confirmed clipboard action. */
export async function executeClipboardSync(action: 'get' | 'set', text: string) {
  const { getClipboard, setClipboard } = await import('../../services/clipboard.js');
  if (action === 'get') {
    const clipText = await getClipboard();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'read',
            chars: clipText.length,
            content: clipText,
            confirmedByUser: true,
          }, null, 2),
        },
      ],
    };
  } else {
    await setClipboard(text);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'written',
            chars: text.length,
            confirmedByUser: true,
          }, null, 2),
        },
      ],
    };
  }
}
