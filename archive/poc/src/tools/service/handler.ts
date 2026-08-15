/**
 * service Tool Handler - system service inspection and control.
 *
 *   - list               → read-only, auto-approved
 *   - start/stop/restart → OTP flow (verification code shown on the device
 *                          screen, never to the AI), confirm executes
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import os from 'node:os';
import { listServices } from '../../services/service-actions.js';
import { createPending } from '../../services/pending-approvals.js';
import { sendDesktopNotification } from '../../services/notifier.js';
import { isTotpProvisioned } from '../../services/otp-auth.js';
import { submitApprovalPush } from '../../services/approval-relay.js';

const isAndroid = os.platform() === 'android';
import { logger } from '../../utils/logger.js';
import type {
  OtpConfirmationRequiredResult,
  ServiceErrorResult,
  ServiceListOkResult,
} from '../../types/tools.js';
import type { ServiceInput } from './schema.js';

function errorResult(error: string) {
  const body: ServiceErrorResult = { status: 'error', error };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

export async function serviceHandler(args: ServiceInput) {
  if (isAndroid) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'unsupported', reason: 'service management requires systemd or Windows SCM — not available on Android' }) }] };
  const { action, name, filter, limit = 50 } = args;

  logger.info('service tool called', { action, name, filter });

  if (action === 'list') {
    try {
      const services = await listServices(filter, limit);
      const body: ServiceListOkResult = {
        status: 'ok',
        total: services.length,
        returned: services.length,
        services,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  // start/stop/restart → owner verification
  if (!name) {
    return errorResult(`${action} requires a service name`);
  }

  const opDetail = `service ${action} ${name}`;
  // One pending op, three delivery modes (first that works wins):
  const { token: confirmToken, nonce } = createPending({
    operation: { kind: 'service', action, name },
    reason: opDetail,
  });

  // Primary: GAP push (out-of-band, AI never sees the nonce)
  if (nonce && (await submitApprovalPush(opDetail, nonce))) {
    const body: OtpConfirmationRequiredResult = {
      status: 'confirmation_required',
      operation: 'service',
      delivery: 'push',
      reason: `${action} service "${name}". An approval request has been pushed to the owner's Feishu/WeChat.`,
      executed: false,
      expiresInSec: 300,
      note: 'Tell the user: an approval request was pushed to your Feishu/WeChat — check it and reply with the number shown there. You do NOT know the number yourself and cannot complete this action without the user\'s reply.',
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  }

  // Fallback 1: TOTP (works remotely, nothing displayed anywhere)
  if (await isTotpProvisioned()) {
    const body: OtpConfirmationRequiredResult = {
      status: 'confirmation_required',
      operation: 'service',
      delivery: 'authenticator',
      reason: `${action} service "${name}". Owner verification required.`,
      executed: false,
      expiresInSec: 300,
      note: 'Ask the user to send the current 6-digit code from their authenticator app, then call confirm with that code. You cannot complete this action without the owner-provided code.',
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  }

  // Fallback 2: desktop popup
  const channel = await sendDesktopNotification(
    'GCA 高危操作验证码',
    `操作: service ${action} ${name} | 验证码: ${confirmToken} | 5 分钟内有效。若非本人操作请忽略。`,
  );

  const body: OtpConfirmationRequiredResult = {
    status: 'confirmation_required',
    operation: 'service',
    delivery: channel === 'msg.exe' ? 'desktop' : 'server-log',
    reason: `${action} service "${name}". A verification code has been shown on the device screen (not to you).`,
    executed: false,
    expiresInSec: 300,
    note: 'Ask the user to read the verification code from the device screen and send it in chat, then call confirm with that code. You cannot complete this action without the user-provided code.',
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
