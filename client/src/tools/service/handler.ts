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
import { config } from '../../config.js';

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

  // start/stop/restart → gca-server ops approval
  if (!name) {
    return errorResult(`${action} requires a service name`);
  }

  const gcaServer = process.env.GCA_SERVER_URL || config.gap?.relayUrl || '';
  let gcaToken = process.env.GCA_MCP_TOKEN || '';
  if (!gcaToken) {
    try {
      const { getSetting } = await import('../../services/settings-store.js');
      gcaToken = (await getSetting<string>('security.mcpToken')) || '';
    } catch { /* ignore */ }
  }
  const opDetail = `service ${action} ${name}`;
  if (!gcaServer) {
    return errorResult('gca-server 未配置（GAP_RELAY_URL）');
  }

  try {
    const res = await fetch(`${gcaServer}/ops/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gcaToken}` },
      body: JSON.stringify({ device: config.deviceName, operation: `service_${action}_${name}`, detail: opDetail }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as { id?: string; code?: string; expiresInSec?: number; error?: string };

    if (data.id) {
      logger.info('service op created on gca-server', { action, name, opId: data.id });
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
              logger.info('service op approved, executing', { action, name });
              const { executeServiceAction } = await import('../../services/service-actions.js');
              await executeServiceAction(action, name);
              return;
            }
            if (statusData.status === 'rejected' || statusData.status === 'expired') {
              logger.warn('service op not approved', { action, name, status: statusData.status });
              return;
            }
          }
        } catch (e) {
          logger.warn('service op poll failed', { error: String(e) });
        }
      }, 1000);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'confirmation_required',
            operation: 'service',
            action,
            name,
            opId: data.id,
            reason: `${action} service "${name}" 已提交审批，确认码已推送到飞书/微信。回复确认码以批准。`,
            executed: false,
            expiresInSec: data.expiresInSec || 300,
          }, null, 2),
        }],
      };
    }

    return errorResult(data.error || 'ops request failed');
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
