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
export interface TotpProvisioning {
    secret: string;
    uri: string;
}
/** True once the owner has provisioned an authenticator. */
export declare function isTotpProvisioned(): Promise<boolean>;
/**
 * Creates and stores a fresh secret. Returns it ONCE for the user to add to
 * their authenticator app — it is never printed again (only re-provisioned).
 */
export declare function provisionTotp(account: string): Promise<TotpProvisioning>;
/**
 * Imports an EXISTING secret (multi-device: one authenticator entry works
 * for every device the owner imports it onto). Returns the same shape as
 * provisionTotp for confirmation display.
 */
export declare function importTotpSecret(account: string, secretBase32: string): Promise<TotpProvisioning>;
/**
 * Verifies a 6-digit code from the owner's authenticator.
 * Window from config (default ±2 steps ≈ up to 150s) so slow model turns
 * don't burn valid codes; replay guard still burns each step after one use.
 */
export declare function verifyOwnerCode(code: string): Promise<boolean>;
/** Seconds until the current code rotates (for UX hints). */
export declare function secondsUntilRotation(): number;
