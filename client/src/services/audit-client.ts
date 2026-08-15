/**
 * Audit Client (INT-003/INT-005) — pushes operation logs to gca-server.
 *
 * Devices call audit() after confirmed operations so the server has a
 * centralized view of who-did-what-when across the fleet.
 *
 * INT-005（审计集中）：开关 `GCA_AUDIT_PUSH=1`（默认关——本地留痕为默认）；
 * 服务器地址优先 GCA_SERVER_URL（desktop/宿主注入），回退 GAP_RELAY_URL / config.gap.relayUrl。
 * 挂钩点：exec 执行/拦截、confirm 审批通过、票据直下传输。
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  /** 缺省时用 config.deviceName */
  deviceId?: string;
  action: string;
  detail?: string;
  status?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  if (process.env.GCA_AUDIT_PUSH !== '1') return; // 默认本地留痕，不推送
  const relay = process.env.GCA_SERVER_URL || process.env.GAP_RELAY_URL || config.gap.relayUrl;
  if (!relay) return;

  // S1：设备自铸 token（服务端 /audit 按设备 token 认证，deviceId 由服务端覆盖）
  const { getDeviceToken } = await import('./device-token.js');
  const bearer = await getDeviceToken();

  try {
    await fetch(`${relay}/audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({
        ...entry,
        deviceId: entry.deviceId || config.deviceName,
        ts: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-blocking — audit is best-effort
  }
}
