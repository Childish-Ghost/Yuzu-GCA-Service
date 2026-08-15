/**
 * OTP Auth - provisioning and verification of the owner's authenticator.
 *
 * The TOTP secret lives in the DPAPI credential store (never in plaintext,
 * never in settings.json, never near the AI). The replay guard's last
 * accepted time step lives in settings (non-secret).
 *
 * Flow for high-risk operations (power/service):
 *   1. Tool creates the pending operation and tells the AI: "ask the user
 *      for their authenticator code" — no code is generated or shown anywhere
 *   2. User reads the current 6-digit code from their authenticator app
 *      and sends it in chat
 *   3. confirm submits the code → verifyOwnerCode() checks it against the
 *      secret (±1 step drift) and rejects replays of older/equal steps
 */

import { getSecret, setSecret } from './credential-store.js';
import { getSetting, setSetting } from './settings-store.js';
import { generateTotpSecret, verifyTotp, buildOtpAuthUri, base32Decode, TOTP_STEP_SEC } from './totp.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const SECRET_NAME = 'totp-owner-secret';
const LAST_STEP_SETTING = 'totp.lastAcceptedStep';

export interface TotpProvisioning {
  secret: string;
  uri: string;
}

/** True once the owner has provisioned an authenticator. */
export async function isTotpProvisioned(): Promise<boolean> {
  return (await getSecret(SECRET_NAME)) !== null;
}

/**
 * Creates and stores a fresh secret. Returns it ONCE for the user to add to
 * their authenticator app — it is never printed again (only re-provisioned).
 */
export async function provisionTotp(account: string): Promise<TotpProvisioning> {
  const secret = generateTotpSecret();
  await setSecret(SECRET_NAME, secret);
  await setSetting(LAST_STEP_SETTING, -1);
  logger.info('TOTP provisioned for owner', { account });
  return { secret, uri: buildOtpAuthUri(secret, account) };
}

/**
 * Imports an EXISTING secret (multi-device: one authenticator entry works
 * for every device the owner imports it onto). Returns the same shape as
 * provisionTotp for confirmation display.
 */
export async function importTotpSecret(account: string, secretBase32: string): Promise<TotpProvisioning> {
  // Validate: must be decodable base32 yielding a plausible secret length
  const decoded = base32Decode(secretBase32);
  if (decoded.length < 10) {
    throw new Error('Invalid TOTP secret (too short after base32 decode)');
  }
  const normalized = secretBase32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  await setSecret(SECRET_NAME, normalized);
  await setSetting(LAST_STEP_SETTING, -1);
  logger.info('TOTP secret imported for owner', { account });
  return { secret: normalized, uri: buildOtpAuthUri(normalized, account) };
}

/**
 * Verifies a 6-digit code from the owner's authenticator.
 * Window from config (default ±2 steps ≈ up to 150s) so slow model turns
 * don't burn valid codes; replay guard still burns each step after one use.
 */
export async function verifyOwnerCode(code: string): Promise<boolean> {
  const secret = await getSecret(SECRET_NAME);
  if (!secret) return false;

  const result = verifyTotp(secret, code, config.approval.totpWindowSteps);
  if (!result.valid) {
    logger.warn('TOTP verification failed', { reason: 'invalid code' });
    return false;
  }

  const lastStep = (await getSetting<number>(LAST_STEP_SETTING)) ?? -1;
  if (result.step <= lastStep) {
    logger.warn('TOTP replay rejected', { step: result.step, lastStep });
    return false;
  }

  await setSetting(LAST_STEP_SETTING, result.step);
  logger.info('TOTP verification passed', { step: result.step });
  return true;
}

/** Seconds until the current code rotates (for UX hints). */
export function secondsUntilRotation(): number {
  return TOTP_STEP_SEC - (Math.floor(Date.now() / 1000) % TOTP_STEP_SEC);
}
