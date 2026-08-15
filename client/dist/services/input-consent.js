/**
 * Input Consent - a time-boxed permission window for remote_input.
 *
 * Same model as screen-consent but separate: controlling the desktop is
 * more dangerous than seeing it. Persisted in settings (input.consentUntil).
 */
import { getSetting, setSetting, deleteSetting } from './settings-store.js';
import { logger } from '../utils/logger.js';
const CONSENT_KEY = 'input.consentUntil';
export async function grantConsent(minutes) {
    const untilMs = Date.now() + minutes * 60_000;
    await setSetting(CONSENT_KEY, untilMs);
    const until = new Date(untilMs).toISOString();
    logger.info('Input consent granted', { minutes, until });
    return { until, minutes };
}
export async function revokeConsent() {
    await deleteSetting(CONSENT_KEY);
    logger.info('Input consent revoked', {});
}
export async function hasConsent() {
    const until = await getSetting(CONSENT_KEY);
    return typeof until === 'number' && Date.now() < until;
}
export async function consentStatus() {
    const until = await getSetting(CONSENT_KEY);
    const active = typeof until === 'number' && Date.now() < until;
    return { active, until: active ? new Date(until).toISOString() : null };
}
//# sourceMappingURL=input-consent.js.map