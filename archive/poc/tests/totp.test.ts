/**
 * Tests for TOTP (RFC 6238) and the authenticator-based confirm flow.
 *
 * Env paths are redirected to a temp dir BEFORE dynamic imports
 * (credential-store / settings-store compute paths at module load).
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const testRoot = join(tmpdir(), `gca-totp-test-${process.pid}`);
process.env.GCA_SETTINGS_PATH = join(testRoot, 'settings.json');
process.env.GCA_SECRETS_DIR = join(testRoot, 'secrets');
process.env.GCA_NOTIFY_CHANNEL = 'server-log';
// Dead relay port → GAP push fails fast, TOTP branch is exercised instead
process.env.GAP_RELAY_URL = 'http://127.0.0.1:1';

const totp = await import('../src/services/totp.js');
const otpAuth = await import('../src/services/otp-auth.js');
const pending = await import('../src/services/pending-approvals.js');
const { confirmHandler } = await import('../src/tools/confirm/handler.js');
const { powerHandler } = await import('../src/tools/power/handler.js');

// RFC 6238 SHA-1 test secret: ASCII "12345678901234567890"
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

beforeEach(async () => {
  await mkdir(testRoot, { recursive: true });
  pending.clearPending();
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('totp primitives', () => {
  it('base32 round-trips', () => {
    const original = Buffer.from('hello world!!');
    assert.deepEqual(totp.base32Decode(totp.base32Encode(original)), original);
  });

  it('matches RFC 6238 test vectors (6-digit truncation)', async () => {
    // RFC vectors are 8-digit; ours is the same value mod 1e6
    assert.equal(totp.totp(RFC_SECRET_B32, 59_000), '287082');
    assert.equal(totp.totp(RFC_SECRET_B32, 1_111_111_109_000), '081804');
    assert.equal(totp.totp(RFC_SECRET_B32, 1_111_111_111_000), '050471');
    assert.equal(totp.totp(RFC_SECRET_B32, 1_234_567_890_000), '005924');
    assert.equal(totp.totp(RFC_SECRET_B32, 2_000_000_000_000), '279037');
  });

  it('verifyTotp accepts exact and ±1 steps, rejects ±2 and garbage', () => {
    const t = 300_000; // step 10 — leaves room for ±2 steps without going negative
    const code = totp.totp(RFC_SECRET_B32, t);
    assert.equal(totp.verifyTotp(RFC_SECRET_B32, code, 1, t).valid, true);
    assert.equal(totp.verifyTotp(RFC_SECRET_B32, totp.totp(RFC_SECRET_B32, t - 30_000), 1, t).valid, true);
    assert.equal(totp.verifyTotp(RFC_SECRET_B32, totp.totp(RFC_SECRET_B32, t - 60_000), 1, t).valid, false);
    assert.equal(totp.verifyTotp(RFC_SECRET_B32, 'abcdef', 1, t).valid, false);
    assert.equal(totp.verifyTotp(RFC_SECRET_B32, '000000', 1, t).valid, false);
  });

  it('builds a valid otpauth URI', () => {
    const uri = totp.buildOtpAuthUri(RFC_SECRET_B32, 'test-device');
    // label colon is percent-encoded per spec (issuer:account)
    assert.match(uri, /^otpauth:\/\/totp\/GCA%3Atest-device\?secret=GEZDG/);
    assert.match(uri, /issuer=GCA/);
  });
});

describe('otp-auth provisioning and verification', () => {
  it('provisions and verifies the current code', async () => {
    const { secret } = await otpAuth.provisionTotp('test-device');
    assert.equal(await otpAuth.isTotpProvisioned(), true);
    const code = totp.totp(secret);
    assert.equal(await otpAuth.verifyOwnerCode(code), true);
  });

  it('rejects replay of the same code', async () => {
    const { secret } = await otpAuth.provisionTotp('test-device');
    const code = totp.totp(secret);
    assert.equal(await otpAuth.verifyOwnerCode(code), true);
    assert.equal(await otpAuth.verifyOwnerCode(code), false);
  });

  it('rejects wrong codes', async () => {
    await otpAuth.provisionTotp('test-device');
    assert.equal(await otpAuth.verifyOwnerCode('000000'), false);
  });

  it('default window (±2) accepts codes up to 2 steps old — slow-model tolerance', async () => {
    const { secret } = await otpAuth.provisionTotp('test-device');
    const twoStepsAgo = totp.totp(secret, Date.now() - 60_000);
    assert.equal(await otpAuth.verifyOwnerCode(twoStepsAgo), true);
  });

  it('replay guard still burns a used step even with the wider window', async () => {
    const { secret } = await otpAuth.provisionTotp('test-device');
    const twoStepsAgo = totp.totp(secret, Date.now() - 60_000);
    assert.equal(await otpAuth.verifyOwnerCode(twoStepsAgo), true);
    assert.equal(await otpAuth.verifyOwnerCode(twoStepsAgo), false);
  });

  it('importTotpSecret: one authenticator entry works across devices', async () => {
    await otpAuth.importTotpSecret('device-B', RFC_SECRET_B32);
    assert.equal(await otpAuth.isTotpProvisioned(), true);
    // Codes computed from the RFC secret must verify (as if provisioned here)
    const code = totp.totp(RFC_SECRET_B32, Date.now());
    assert.equal(await otpAuth.verifyOwnerCode(code), true);
  });

  it('importTotpSecret rejects garbage', async () => {
    await assert.rejects(otpAuth.importTotpSecret('device-C', 'ABC'), /Invalid TOTP secret/);
  });
});

describe('TOTP confirm flow (power/service)', () => {
  it('power returns authenticator delivery with NO token when TOTP provisioned', async () => {
    await otpAuth.provisionTotp('test-device');
    const r = parseResult(await powerHandler({ action: 'shutdown', delaySec: 600 }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.delivery, 'authenticator');
    assert.equal(r.confirmToken, undefined, 'no token may be exposed to the AI');
  });

  it('valid authenticator code executes the pending op (reaches execution layer)', async () => {
    const { secret } = await otpAuth.provisionTotp('test-device');
    // Seed a benign high-risk op: service start on a fake service fails
    // gracefully at the execution layer — proving dispatch happened.
    pending.createPending({
      operation: { kind: 'service', action: 'start', name: 'gca-fake-svc-totp' },
      reason: 'test',
    });
    const code = totp.totp(secret);
    const result = await confirmHandler({ token: code });
    const parsed = parseResult(result);
    // confirm_failed would mean the TOTP path rejected us; an execution-layer
    // error (fake service) proves the op WAS dispatched.
    assert.notEqual(parsed.status, 'confirm_failed');
    assert.equal(result.isError, true); // fake service errors gracefully
  });

  it('wrong authenticator code → confirm_failed', async () => {
    await otpAuth.provisionTotp('test-device');
    pending.createPending({
      operation: { kind: 'service', action: 'start', name: 'gca-fake-svc-totp2' },
      reason: 'test',
    });
    const result = await confirmHandler({ token: '000000' });
    assert.equal(parseResult(result).status, 'confirm_failed');
  });

  it('chat-token flow still works alongside TOTP', async () => {
    await otpAuth.provisionTotp('test-device');
    const token = pending.createPending({
      operation: { kind: 'service', action: 'start', name: 'gca-fake-svc-totp3' },
      reason: 'test',
    }).token;
    const result = await confirmHandler({ token });
    assert.notEqual(parseResult(result).status, 'confirm_failed');
  });
});
