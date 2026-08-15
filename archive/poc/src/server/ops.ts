/**
 * High-risk operation authorization — confirmation codes + approval broker.
 *
 * Flow:
 *   1. Device POST /ops/request { device, operation, detail }
 *   2. Server generates 6-digit code, pushes to feishu/wechat:
 *      "设备 X 请求 [operation]，确认码: 482931 (5分钟有效)"
 *   3. Owner replies with the code in any chat channel
 *   4. Server POST /ops/approve { code } → approved
 *   5. Device polls GET /ops/status/:id → "approved" → executes
 */
import { randomInt } from 'node:crypto';
import { push } from './push.js';
import { pushEntry } from './audit.js';

const CODE_TTL_MS = 5 * 60 * 1000;

interface PendingOp {
  id: string;
  device: string;
  operation: string;
  detail: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  deviceIp?: string;
}

const ops = new Map<string, PendingOp>();

export function createOpRequest(device: string, operation: string, detail: string, deviceIp?: string): { id: string; code: string; expiresInSec: number } {
  const id = `${Date.now().toString(36)}-${randomInt(1000, 9999)}`;
  const code = String(randomInt(100000, 999999));

  ops.set(id, {
    id,
    device,
    operation,
    detail: detail.slice(0, 200),
    code,
    status: 'pending',
    createdAt: Date.now(),
    deviceIp,
  });

  // Push confirmation code to owner
  push(`设备 ${device} 请求 ${operation}，确认码: ${code} (5分钟有效)
    ${detail ? `详情: ${detail}` : ''}
    回复确认码以批准操作。`);

  pushEntry({
    ts: Date.now(),
    deviceId: device,
    action: `ops_request:${operation}`,
    detail: `code:${code}`,
    status: 'pending',
  });

  return { id, code, expiresInSec: 300 };
}

export function approveOp(code: string): { ok: boolean; op?: PendingOp; error?: string } {
  // Clean expired
  for (const [id, op] of ops) {
    if (Date.now() - op.createdAt > CODE_TTL_MS && op.status === 'pending') {
      op.status = 'expired';
    }
  }

  const entry = [...ops.values()].find(o => o.code === code && o.status === 'pending');
  if (!entry) return { ok: false, error: 'invalid or expired code' };

  entry.status = 'approved';

  pushEntry({
    ts: Date.now(),
    deviceId: entry.device,
    action: `ops_approved:${entry.operation}`,
    detail: '',
    status: 'approved',
  });

  return { ok: true, op: entry };
}

export function rejectOp(code: string): boolean {
  const entry = [...ops.values()].find(o => o.code === code && o.status === 'pending');
  if (!entry) return false;
  entry.status = 'rejected';
  return true;
}

export function getOpStatus(id: string): PendingOp | undefined {
  return ops.get(id);
}

/** Cleanup expired ops (call periodically) */
export function sweepOps(): number {
  let cleaned = 0;
  for (const [id, op] of ops) {
    if (Date.now() - op.createdAt > CODE_TTL_MS && op.status === 'pending') {
      op.status = 'expired';
      cleaned++;
    }
  }
  return cleaned;
}

// Periodic sweep
setInterval(sweepOps, 60000);