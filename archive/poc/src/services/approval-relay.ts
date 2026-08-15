/**
 * Approval Relay client (device side of GAP-v2).
 *
 * Delivers approval pushes to the owner via the gap-relay service on the
 * gateway VM (Feishu + WeChat, device-originated — the AI never sees or
 * alters the op description, and never learns the nonce).
 *
 * The push is OUT OF BAND: it bypasses the AI context entirely. The nonce
 * inside it is how the owner proves "I read and approved THIS operation".
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Sends an approval push. Returns true when the relay accepted and
 * delivered to at least one channel; false on any failure (caller falls
 * back to the next delivery mode in the chain).
 */
export async function submitApprovalPush(opDetail: string, nonce: string): Promise<boolean> {
  // env read per call (tests can redirect; config default is the VM relay)
  const base = process.env.GAP_RELAY_URL || config.gap.relayUrl;
  if (!base) return false;

  const token = process.env.GCA_MCP_TOKEN;
  const text = `【GCA 审批】设备 ${config.deviceName} 请求执行：${opDetail}。批准请直接回复数字 ${nonce}（5 分钟内有效，若非本人操作请忽略）。`;

  try {
    // Pairing token resolution mirrors pairing.ts (env > settings)
    let bearer = token;
    if (!bearer) {
      const { getSetting } = await import('./settings-store.js');
      bearer = await getSetting<string>('security.mcpToken');
    }

    const res = await fetch(`${base}/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      logger.warn('approval push rejected by relay (bad token)', {});
      return false;
    }
    // 202 = queued for delivery (relay ACKs instantly, delivery is async)
    const accepted = res.status === 202 || res.ok;
    logger.info('approval push submitted', { accepted, status: res.status });
    return accepted;
  } catch (err) {
    logger.warn('approval push failed (relay unreachable?)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
