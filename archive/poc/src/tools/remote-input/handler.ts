/**
 * remote_input Tool Handler (R-002) - keyboard + mouse control.
 *
 * HIGHEST RISK tool: can type passwords, click anything, control the entire
 * desktop. Privacy model (same as screenshot but separate consent):
 *   - Inside an active input_consent window → execute immediately
 *   - Outside → confirmation_required per action
 */

import os from 'node:os';
import { createPending } from '../../services/pending-approvals.js';
import { hasConsent } from '../../services/input-consent.js';
import { executeInput, type InputAction } from '../../services/input-simulator.js';
import { logger } from '../../utils/logger.js';
import type { RemoteInputInput } from './schema.js';

const isAndroid = os.platform() === 'android';

function errorResult(error: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error }, null, 2) }],
    isError: true,
  };
}

export async function remoteInputHandler(args: RemoteInputInput) {
  if (isAndroid) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'unsupported', reason: 'remote_input requires AccessibilityService — not available in embedded Node.js on Android' }) }] };
  const { action, x, y, button = 'left', delta = 0, text = '' } = args;

  logger.info('remote_input tool called', { action, x, y, button, delta, textLen: text.length });

  let inputAction: InputAction;
  switch (action) {
    case 'mouse_move':
      if (x === undefined || y === undefined) return errorResult('mouse_move requires x and y');
      inputAction = { type: 'mouse_move', x, y };
      break;
    case 'mouse_click':
      inputAction = { type: 'mouse_click', button, x, y };
      break;
    case 'mouse_scroll':
      inputAction = { type: 'mouse_scroll', delta, x, y };
      break;
    case 'key_type':
      if (!text) return errorResult('key_type requires text');
      inputAction = { type: 'key_type', text };
      break;
  }

  // Inside an active consent window: execute immediately
  if (await hasConsent()) {
    return executeRemoteInput(inputAction, false);
  }

  createPending({
    operation: { kind: 'remote_input', inputAction },
    reason: `remote_input ${action}`,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'confirmation_required',
          operation: 'remote_input',
          reason: `Execute ${action} on this device's desktop (privacy-sensitive: it controls mouse/keyboard). Nothing has been executed yet. Tip: the input_consent tool can open a timed window that skips per-action confirmation.`,
          executed: false,
          expiresInSec: 300,
          note: 'Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.',
        }, null, 2),
      },
    ],
  };
}

/** Executes the confirmed/consented input action. */
export async function executeRemoteInput(inputAction: InputAction, confirmedByUser = true) {
  try {
    const detail = await executeInput(inputAction);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'executed',
            action: inputAction.type,
            detail,
            confirmedByUser,
          }, null, 2),
        },
      ],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('remote_input failed', { error: errorMessage });
    return errorResult(errorMessage);
  }
}
