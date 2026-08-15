/**
 * power Tool Handler — system power control via gca-server ops.
 *
 * All power actions (shutdown/restart/sleep/hibernate/wol) go through
 * gca-server's ops approval system. No local pending-approvals.
 */

import os from 'node:os';
import { config } from '../../config.js';
import { executePowerAction } from '../../services/power-actions.js';
import { logger } from '../../utils/logger.js';
import type { PowerOkResult } from '../../types/tools.js';
import type { PowerInput } from './schema.js';

const isAndroid = os.platform() === 'android';

export async function powerHandler(args: PowerInput) {
  if (isAndroid) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'unsupported', reason: 'power actions not available on Android' }) }] };
  const { action, delaySec = 30, mac } = args;

  logger.info('power tool called', { action, delaySec, mac });

  // abort: auto-approved (removes danger)
  if (action === 'abort') {
    try {
      const detail = await executePowerAction({ action: 'abort' });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', action, detail } as PowerOkResult, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
    }
  }

  // wol: needs mac, simple confirm
  if (action === 'wol') {
    if (!mac) return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: 'wol requires a mac parameter' }, null, 2) }], isError: true };
    try {
      const detail = await executePowerAction({ action, mac });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', action, detail } as PowerOkResult, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
    }
  }

  // shutdown/restart/sleep/hibernate → gca-server ops approval。
  // S1：设备自铸 token（/ops/request 设备通道认证；服务端用认证身份覆盖 device 字段）
  const gcaServer = process.env.GCA_SERVER_URL || config.gap?.relayUrl || '';
  let gcaToken = '';
  try {
    const { getDeviceToken } = await import('../../services/device-token.js');
    gcaToken = (await getDeviceToken()) || '';
  } catch { /* ignore */ }
  const opDetail = `${action}（${delaySec}秒后执行）`;
  if (!gcaServer) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: 'gca-server 未配置（GAP_RELAY_URL）' }, null, 2) }], isError: true };
  }

  try {
    const res = await fetch(`${gcaServer}/ops/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gcaToken}` },
      body: JSON.stringify({ device: config.deviceName, operation: `power_${action}`, detail: opDetail }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as { id?: string; code?: string; expiresInSec?: number; error?: string };

    if (data.id) {
      logger.info('power op created on gca-server', { action, opId: data.id, code: data.code });
      // 后台轮询审批状态，approved 后自动执行
      const opId = data.id;
      setTimeout(async () => {
        try {
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            const statusRes = await fetch(`${gcaServer}/ops/${opId}`, {
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gcaToken}` },
              signal: AbortSignal.timeout(5000),
            });
            const statusData = await statusRes.json() as { status?: string };
            if (statusData.status === 'approved') {
              logger.info('power op approved, executing', { action });
              await executePowerAction({ action, delaySec });
              return;
            }
            if (statusData.status === 'rejected' || statusData.status === 'expired') {
              logger.warn('power op not approved', { action, status: statusData.status });
              return;
            }
          }
        } catch (e) {
          logger.warn('power op poll failed', { error: String(e) });
        }
      }, 1000);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'confirmation_required',
            operation: 'power',
            action,
            opId: data.id,
            reason: `${action} 已提交审批，确认码已推送到飞书/微信。回复确认码以批准。`,
            executed: false,
            expiresInSec: data.expiresInSec || 300,
          }, null, 2),
        }],
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: data.error || 'ops request failed' }, null, 2) }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', action, error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
  }
}
