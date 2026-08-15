/**
 * Pairing code management — mint, validate, claim.
 * One-time codes, 10-min TTL, auto-register device in openclaw.json on claim.
 */
import { randomInt } from 'node:crypto';
import { serverConfig } from './config.js';
import { registerDevice } from './devices.js';

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
): Promise<{ ok: boolean; error?: string; pairingToken?: string }> {
  const entry = codes.get(code);
  if (!entry || Date.now() > entry.expiresAt || entry.claimed) {
    return { ok: false, error: 'invalid, expired, or already claimed code' };
  }
  entry.claimed = true;
  codes.delete(code);

  try {
    await registerDevice(deviceName || `device-${Date.now().toString(36)}`, deviceIp, devicePort, serverConfig.token);
    return { ok: true, pairingToken: serverConfig.token };
  } catch (err) {
    return { ok: false, error: `registration failed: ${err instanceof Error ? err.message : err}` };
  }
}