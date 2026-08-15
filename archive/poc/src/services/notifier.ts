/**
 * Desktop Notifier - delivers messages to the device owner OUT OF BAND.
 *
 * Primary channel: msg.exe (built into Windows Pro/Workstation) — pops a
 * dialog in the console session. Fallback: a banner in the server log.
 *
 * This is the delivery channel for OTP verification codes (power/service
 * confirmations): the code must reach the human WITHOUT passing through the
 * AI, so the AI can never self-confirm a dangerous operation.
 */

import { executeCommand } from './executor.js';
import { logger } from '../utils/logger.js';

export type NotifyChannel = 'msg.exe' | 'server-log';

/**
 * Sends a desktop notification. Returns the channel actually used.
 * Never throws — delivery problems degrade to the server log.
 */
export async function sendDesktopNotification(title: string, message: string): Promise<NotifyChannel> {
  // Test/automation override: force the log channel (checked per-call)
  if (process.env.GCA_NOTIFY_CHANNEL === 'server-log') {
    logger.warn('DESKTOP NOTIFICATION (forced server-log channel)', { title, message });
    return 'server-log';
  }

  if (process.platform === 'win32') {
    try {
      // Sanitize for cmd: strip characters that could break the command line
      const safe = `${title}: ${message}`.replace(/[&|<>^"%]/g, ' ').substring(0, 240);
      const result = await executeCommand(`msg * /TIME:60 ${safe}`, { timeout: 10000 });
      if (result.exitCode === 0) {
        logger.info('Desktop notification sent via msg.exe', { title });
        return 'msg.exe';
      }
      logger.warn('msg.exe notification failed, falling back to server log', {
        exitCode: result.exitCode,
        stderr: result.stderr.substring(0, 120),
      });
    } catch (err) {
      logger.warn('msg.exe notification error, falling back to server log', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn('DESKTOP NOTIFICATION (server-log channel)', { title, message });
  return 'server-log';
}
