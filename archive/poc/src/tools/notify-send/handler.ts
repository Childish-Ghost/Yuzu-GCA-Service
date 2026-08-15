/**
 * notify_send Tool Handler - pops a desktop notification on this device.
 *
 * Useful for the AI to reach the human at the keyboard — status updates,
 * "your task finished", or a heads-up before a disruptive action.
 *
 * Read-only-ish (no system state change), auto-approved.
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import os from 'node:os';
import { sendDesktopNotification } from '../../services/notifier.js';
import { logger } from '../../utils/logger.js';
import type { NotifySendOkResult } from '../../types/tools.js';
import type { NotifySendInput } from './schema.js';

const isAndroid = os.platform() === 'android';

export async function notifySendHandler(args: NotifySendInput) {
  if (isAndroid) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'unsupported', reason: 'notify_send requires native notification API — use Kotlin NotificationManager on Android' }) }] };
  const { message, title = 'GCA' } = args;

  logger.info('notify_send tool called', { title, chars: message.length });

  const channel = await sendDesktopNotification(title, message);

  const body: NotifySendOkResult = { status: 'sent', channel, title };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
