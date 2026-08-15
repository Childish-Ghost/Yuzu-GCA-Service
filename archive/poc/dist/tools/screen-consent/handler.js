/**
 * screen_consent Tool Handler - manages the screenshot permission window.
 *
 * Granting a window (minutes > 0) lowers the privacy bar for a while, so it
 * always goes through the confirmation flow. Revoking (minutes = 0) raises
 * it back — that is free and instant.
 */
import os from 'node:os';
import { createPending } from '../../services/pending-approvals.js';
import { revokeConsent, consentStatus } from '../../services/screen-consent.js';
import { logger } from '../../utils/logger.js';
const isAndroid = os.platform() === 'android';
export async function screenConsentHandler(args) {
    if (isAndroid)
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'unsupported', reason: 'screen_consent requires foreground Activity dialog — not available in embedded Node.js on Android' }) }] };
    const { minutes } = args;
    logger.info('screen_consent tool called', { minutes });
    // Revoke: free and instant (it RAISES the privacy bar)
    if (minutes === 0) {
        await revokeConsent();
        return {
            content: [
                {
                    type: 'text',
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
                    type: 'text',
                    text: JSON.stringify({
                        status: 'already_active',
                        until: status.until,
                        note: 'A screenshot consent window is already active. Granting a new one is not needed (or revoke it first with minutes=0).',
                    }, null, 2),
                },
            ],
        };
    }
    createPending({
        operation: { kind: 'screen_consent', minutes },
        reason: `screen_consent ${minutes}min`,
    });
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    status: 'confirmation_required',
                    operation: 'screen_consent',
                    reason: `Grant a ${minutes}-minute window during which screenshots may be captured WITHOUT per-shot confirmation. Nothing changes yet.`,
                    executed: false,
                    expiresInSec: 300,
                    note: 'Ask the user to confirm. When they agree, call confirm with NO arguments to execute the most recent pending operation. Expires in 300 seconds.',
                }, null, 2),
            },
        ],
    };
}
//# sourceMappingURL=handler.js.map