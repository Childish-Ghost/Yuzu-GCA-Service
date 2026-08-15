/**
 * TOTP (RFC 6238) - time-based one-time passwords with zero dependencies.
 *
 * HMAC-SHA1, 30-second step, 6 digits — compatible with Google Authenticator,
 * Microsoft Authenticator, 1Password, etc.
 *
 * Secrets are random 20-byte values, shown to the user once as base32
 * (for manual entry) and as an otpauth:// URI (for QR scanners).
 */
export declare const TOTP_STEP_SEC = 30;
export declare const TOTP_DIGITS = 6;
export declare function base32Encode(buf: Buffer): string;
export declare function base32Decode(str: string): Buffer;
/** Generates a fresh 160-bit secret (base32 text form, groupable for display). */
export declare function generateTotpSecret(): string;
/** The TOTP code for a given time (defaults to now). */
export declare function totp(secretBase32: string, timeMs?: number): string;
export interface TotpVerifyResult {
    valid: boolean;
    /** The accepted time step — feed to the replay guard. -1 when invalid. */
    step: number;
}
/** Verifies a user-provided code, tolerating ±window steps of clock drift. */
export declare function verifyTotp(secretBase32: string, code: string, window?: number, timeMs?: number): TotpVerifyResult;
/** Builds an otpauth:// URI for QR scanners / authenticator imports. */
export declare function buildOtpAuthUri(secretBase32: string, account: string, issuer?: string): string;
