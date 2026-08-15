/**
 * TOTP (RFC 6238) - time-based one-time passwords with zero dependencies.
 *
 * HMAC-SHA1, 30-second step, 6 digits — compatible with Google Authenticator,
 * Microsoft Authenticator, 1Password, etc.
 *
 * Secrets are random 20-byte values, shown to the user once as base32
 * (for manual entry) and as an otpauth:// URI (for QR scanners).
 */
import { createHmac, randomBytes } from 'node:crypto';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
export function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}
export function base32Decode(str) {
    const clean = str.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
/** Generates a fresh 160-bit secret (base32 text form, groupable for display). */
export function generateTotpSecret() {
    return base32Encode(randomBytes(20));
}
function hotp(secret, counter) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(counter);
    const digest = createHmac('sha1', secret).update(msg).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);
    return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
/** The TOTP code for a given time (defaults to now). */
export function totp(secretBase32, timeMs = Date.now()) {
    const counter = BigInt(Math.floor(timeMs / 1000 / TOTP_STEP_SEC));
    return hotp(base32Decode(secretBase32), counter);
}
/** Verifies a user-provided code, tolerating ±window steps of clock drift. */
export function verifyTotp(secretBase32, code, window = 1, timeMs = Date.now()) {
    const normalized = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) {
        return { valid: false, step: -1 };
    }
    const currentStep = Math.floor(timeMs / 1000 / TOTP_STEP_SEC);
    const secret = base32Decode(secretBase32);
    for (let drift = -window; drift <= window; drift++) {
        const step = currentStep + drift;
        if (step < 0)
            continue;
        if (hotp(secret, BigInt(step)) === normalized) {
            return { valid: true, step };
        }
    }
    return { valid: false, step: -1 };
}
/** Builds an otpauth:// URI for QR scanners / authenticator imports. */
export function buildOtpAuthUri(secretBase32, account, issuer = 'GCA') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}
//# sourceMappingURL=totp.js.map