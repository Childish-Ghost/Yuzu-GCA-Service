/**
 * Screen Consent - a time-boxed permission window for screenshots.
 *
 * The owner grants once (via the screen_consent tool, itself behind the
 * confirmation flow) and screenshots run freely until the window expires.
 * Outside the window every screenshot needs its own confirmation.
 *
 * Persisted in settings (screen.consentUntil) so restarts don't silently
 * extend or revoke the window.
 */

import { getSetting, setSetting, deleteSetting } from './settings-store.js';
import { logger } from '../utils/logger.js';

const CONSENT_KEY = 'screen.consentUntil';

export async function grantConsent(minutes: number): Promise<{ until: string; minutes: number }> {
  const untilMs = Date.now() + minutes * 60_000;
  await setSetting(CONSENT_KEY, untilMs);
  const until = new Date(untilMs).toISOString();
  logger.info('Screen consent granted', { minutes, until });
  return { until, minutes };
}

export async function revokeConsent(): Promise<void> {
  await deleteSetting(CONSENT_KEY);
  logger.info('Screen consent revoked', {});
}

export async function hasConsent(): Promise<boolean> {
  const until = await getSetting<number>(CONSENT_KEY);
  return typeof until === 'number' && Date.now() < until;
}

export async function consentStatus(): Promise<{ active: boolean; until: string | null }> {
  const until = await getSetting<number>(CONSENT_KEY);
  const active = typeof until === 'number' && Date.now() < until;
  return { active, until: active ? new Date(until as number).toISOString() : null };
}
