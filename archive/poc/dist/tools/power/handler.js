/**
 * power Tool Handler - system power control with OTP verification.
 *
 * High-risk policy (security.md: shutdown/reboot must go through this tool):
 *   - shutdown / restart / sleep / hibernate → OTP flow: a verification code
 *     pops up on THIS DEVICE's screen (out of band, the AI never sees it);
 *     the user types the code in chat; confirm executes.
 *   - wol (harmless outbound packet) → normal chat-token confirmation.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import os from 'node:os';
import { createPending } from '../../services/pending-approvals.js';
import { sendDesktopNotification } from '../../services/notifier.js';
import { executePowerAction } from '../../services/power-actions.js';
import { isTotpProvisioned } from '../../services/otp-auth.js';
import { submitApprovalPush } from '../../services/approval-relay.js';
import { logger } from '../../utils/logger.js';
const isAndroid = os.platform() === 'android';
const OTP_ACTIONS = new Set(['shutdown', 'restart', 'sleep', 'hibernate']);
export async function powerHandler(args) {
    if (isAndroid)
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'unsupported', reason: 'power actions require DevicePolicyManager or root — not available in embedded Node.js on Android' }) }] };
    const { action, delaySec = 30, mac } = args;
    logger.info('power tool called', { action, delaySec, mac });
    // --- abort: cancels a scheduled shutdown/restart — auto-approved (it REMOVES danger) ---
    if (action === 'abort') {
        try {
            const detail = await executePowerAction({ action: 'abort' });
            const body = { status: 'ok', action, detail };
            return {
                content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ status: 'error', action, error: errorMessage }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    }
    if (OTP_ACTIONS.has(action)) {
        const opDetail = `${action}（${delaySec} 秒后执行）`;
        // One pending op, three delivery modes (first that works wins):
        const { token: confirmToken, nonce } = createPending({
            operation: { kind: 'power', action, delaySec },
            reason: `power ${action} (delay ${delaySec}s)`,
        });
        // --- Primary: GAP push (out-of-band, AI never sees the nonce) ---
        if (nonce && (await submitApprovalPush(opDetail, nonce))) {
            const body = {
                status: 'confirmation_required',
                operation: 'power',
                delivery: 'push',
                reason: `${action} scheduled with ${delaySec}s delay. An approval request has been pushed to the owner's Feishu/WeChat.`,
                executed: false,
                expiresInSec: 300,
                note: 'Tell the user: an approval request was pushed to your Feishu/WeChat — check it and reply with the number shown there. You do NOT know the number yourself and cannot complete this action without the user\'s reply.',
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            };
        }
        // --- Fallback 1: TOTP authenticator code ---
        if (await isTotpProvisioned()) {
            const body = {
                status: 'confirmation_required',
                operation: 'power',
                delivery: 'authenticator',
                reason: `${action} scheduled with ${delaySec}s delay. Owner verification required.`,
                executed: false,
                expiresInSec: 300,
                note: 'Ask the user to send the current 6-digit code from their authenticator app, then call confirm with that code. You cannot complete this action without the owner-provided code.',
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            };
        }
        // --- Fallback 2: desktop popup (owner must be at the device) ---
        const channel = await sendDesktopNotification('GCA 高危操作验证码', `操作: ${action} | 验证码: ${confirmToken} | 5 分钟内有效。若非本人操作请忽略。`);
        const body = {
            status: 'confirmation_required',
            operation: 'power',
            delivery: channel === 'msg.exe' ? 'desktop' : 'server-log',
            reason: `${action} scheduled with ${delaySec}s delay. A verification code has been shown on the device screen (not to you).`,
            executed: false,
            expiresInSec: 300,
            note: 'Ask the user to read the verification code from the device screen and send it in chat, then call confirm with that code. You cannot complete this action without the user-provided code.',
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        };
    }
    // --- wol: normal chat-token confirmation ---
    if (!mac) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ status: 'error', action, error: 'wol requires a mac parameter' }, null, 2),
                },
            ],
            isError: true,
        };
    }
    createPending({
        operation: { kind: 'power', action, mac },
        reason: `power wol ${mac}`,
    });
    const body = {
        status: 'confirmation_required',
        operation: 'power',
        reason: `Send a Wake-on-LAN magic packet to ${mac}. Nothing has been sent yet.`,
        executed: false,
        expiresInSec: 300,
        note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
}
//# sourceMappingURL=handler.js.map