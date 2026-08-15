/**
 * One-time TOTP provisioning for the owner.
 *
 *   npm run setup:totp                          — provision (refuses if already set)
 *   npm run setup:totp -- --force               — re-provision (INVALIDATES the old secret)
 *   npm run setup:totp -- --import <BASE32KEY>  — import an existing secret
 *                                                 (multi-device: one authenticator
 *                                                 entry works for every device)
 *
 * Prints the base32 secret (for manual entry) and the otpauth:// URI
 * (paste into a QR generator or your authenticator's "import" field).
 * The secret is stored in the DPAPI credential store and never shown again.
 */

import { provisionTotp, importTotpSecret, isTotpProvisioned } from '../src/services/otp-auth.js';
import { config } from '../src/config.js';

const force = process.argv.includes('--force');
const importIdx = process.argv.indexOf('--import');
const importValue = importIdx >= 0 ? process.argv[importIdx + 1] : undefined;
const already = await isTotpProvisioned();

if (already && !force && !importValue) {
  console.error('TOTP is already provisioned. Re-run with --force to replace the secret (this invalidates the old one).');
  process.exit(1);
}

const account = config.deviceName;
const { secret, uri } = importValue
  ? await importTotpSecret(account, importValue)
  : await provisionTotp(account);

const grouped = secret.replace(/(.{4})/g, '$1 ').trim();

console.log('');
console.log('=== GCA Owner Authenticator Provisioning ===');
console.log('');
if (importValue) {
  console.log('Imported existing secret (multi-device mode — same authenticator entry as your other devices).');
  console.log('');
}
console.log('1. Open your authenticator app (Google/Microsoft Authenticator, 1Password, ...)');
console.log('2. Add an account with this key (manual entry):');
console.log('');
console.log(`     ${grouped}`);
console.log('');
console.log('   or import this URI (e.g. via a QR generator):');
console.log('');
console.log(`     ${uri}`);
console.log('');
console.log('From now on, power/service operations will ask for the 6-digit code from this app.');
console.log('The secret is stored encrypted (DPAPI, current Windows user only). It is NOT shown again.');

