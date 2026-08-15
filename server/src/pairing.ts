/**
 * Pairing code management — mint, validate, claim.
 * One-time codes, 10-min TTL, auto-register device in openclaw.json on claim.
 *
 * 2026-08-12 审查 S1 修复：配对消耗时设备携带**自己铸造**的 deviceToken
 * （≥32 字符），服务端只存储、不再把 owner 管理 token 发给设备。
 */
import { randomInt } from 'node:crypto';
import { registerDevice, isValidDeviceToken } from './devices.js';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_TTL_MS = 10 * 60 * 1000;

interface PairingEntry {
  expiresAt: number;
  claimed: boolean;
}

const codes = new Map<string, PairingEntry>();

export function mintCode(): string {
  for (const [code, entry] of codes) {
    if (Date.now() > entry.expiresAt) codes.delete(code);
  }
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  while (codes.has(code)) {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  codes.set(code, { expiresAt: Date.now() + CODE_TTL_MS, claimed: false });
  return code;
}

export async function claimCode(
  code: string,
  deviceName: string,
  deviceIp: string,
  devicePort: number,
  deviceToken: string,
  machineId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = codes.get(code);
  if (!entry || Date.now() > entry.expiresAt || entry.claimed) {
    return { ok: false, error: 'invalid, expired, or already claimed code' };
  }
  if (!isValidDeviceToken(deviceToken)) {
    return { ok: false, error: 'deviceToken required (min 32 chars, minted by device)' };
  }
  entry.claimed = true;
  codes.delete(code);

  try {
    await registerDevice(deviceName || `device-${Date.now().toString(36)}`, deviceIp, devicePort, deviceToken, machineId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `registration failed: ${err instanceof Error ? err.message : err}` };
  }
}