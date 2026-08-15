/**
 * input_consent Tool Handler - manages the remote_input permission window.
 * Same pattern as screen_consent but for keyboard/mouse control.
 */

import os from 'node:os';
import { createPending } from '../../services/pending-approvals.js';
import { revokeConsent, consentStatus } from '../../services/input-consent.js';
import { logger } from '../../utils/logger.js';
import type { InputConsentInput } from './schema.js';

const isAndroid = os.platform() === 'android';

export async function inputConsentHandler(args: InputConsentInput) {
  if (isAndroid) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'unsupported', reason: 'input_consent requires foreground Activity dialog — not available in embedded Node.js on Android' }) }] };
  const { minutes } = args;

  logger.info('input_consent tool called', { minutes });

  if (minutes === 0) {
    await revokeConsent();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ status: 'revoked', active: false }, null, 2),
        },
      ],
    };
  }

  const status = await consentStatus();
  if (status.active) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'already_active',
            until: status.until,
            note: 'An input consent window is already active. Revoke it first with minutes=0 if you need a fresh one.',
          }, null, 2),
        },
      ],
    };
  }

  createPending({
    operation: { kind: 'input_consent', minutes },
    reason: `input_consent ${minutes}min`,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'confirmation_required',
          operation: 'input_consent',
          reason: `Grant a ${minutes}-minute window during which remote_input runs WITHOUT per-action confirmation. This gives the AI full keyboard+mouse control of this device. Nothing changes yet.`,
          executed: false,
          expiresInSec: 300,
          note: 'Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.',
        }, null, 2),
      },
    ],
  };
}
