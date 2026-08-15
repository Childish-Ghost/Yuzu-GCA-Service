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
export type NotifyChannel = 'msg.exe' | 'server-log';
/**
 * Sends a desktop notification. Returns the channel actually used.
 * Never throws — delivery problems degrade to the server log.
 */
export declare function sendDesktopNotification(title: string, message: string): Promise<NotifyChannel>;
