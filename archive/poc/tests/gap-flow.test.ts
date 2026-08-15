/**
 * Tests for the GAP-v2 push approval flow:
 *   power/service → push nonce delivered out-of-band → confirm(nonce)
 *   wrong nonces burn the op after 3 attempts
 *
 * fetch is stubbed per test so no network is touched.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const testRoot = join(tmpdir(), `gca-gap-test-${process.pid}`);
process.env.GCA_SETTINGS_PATH = join(testRoot, 'settings.json');
process.env.GCA_SECRETS_DIR = join(testRoot, 'secrets');
process.env.GCA_NOTIFY_CHANNEL = 'server-log';
delete process.env.GAP_RELAY_URL; // exercise the config default branch logic via stubbed fetch

const pending = await import('../src/services/pending-approvals.js');
const { confirmHandler } = await import('../src/tools/confirm/handler.js');
const { powerHandler } = await import('../src/tools/power/handler.js');
const { serviceHandler } = await import('../src/tools/service/handler.js');

const realFetch = globalThis.fetch;
let pushCalls = [];

function stubRelay(status = 202) {
  pushCalls = [];
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: true }), { status });
  };
}

function parseResult(handlerReturn) {
  return JSON.parse(handlerReturn.content[0].text);
}

beforeEach(async () => {
  await mkdir(testRoot, { recursive: true });
  pending.clearPending();
  stubRelay();
});

after(async () => {
  globalThis.fetch = realFetch;
  await rm(testRoot, { recursive: true, force: true });
});

describe('GAP push delivery', () => {
  it('power returns push delivery, no token exposed, relay called once', async () => {
    const r = parseResult(await powerHandler({ action: 'shutdown', delaySec: 600 }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.delivery, 'push');
    assert.equal(r.confirmToken, undefined, 'nonce must not be exposed to the AI');
    assert.equal(pushCalls.length, 1);
    const sentText = JSON.parse(pushCalls[0].init.body).text;
    assert.match(sentText, /shutdown/);
    assert.match(sentText, /批准请直接回复数字 \d{3}/);
  });

  it('service also uses push delivery', async () => {
    const r = parseResult(await serviceHandler({ action: 'restart', name: 'wuauserv' }));
    assert.equal(r.delivery, 'push');
    const sentText = JSON.parse(pushCalls[0].init.body).text;
    assert.match(sentText, /service restart wuauserv/);
  });

  it('relay failure falls back to desktop/server-log (no TOTP here)', async () => {
    stubRelay(500);
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    const r = parseResult(await powerHandler({ action: 'shutdown', delaySec: 600 }));
    assert.equal(r.delivery, 'server-log');
  });
});

describe('GAP nonce confirm flow', () => {
  it('correct 3-digit nonce executes the pending op (reaches execution layer)', async () => {
    // Seed a service pending directly and read its nonce via a power call's push text
    await powerHandler({ action: 'shutdown', delaySec: 600 });
    const sentText = JSON.parse(pushCalls[0].init.body).text;
    const nonce = sentText.match(/批准请直接回复数字 (\d{3})/)[1];

    const result = await confirmHandler({ token: nonce });
    const parsed = parseResult(result);
    // Reaching the power execution layer (ok or graceful error) proves dispatch;
    // confirm_failed would mean the nonce path rejected us.
    assert.notEqual(parsed.status, 'confirm_failed');
  });

  it('wrong nonce → confirm_failed, and op burns after 3 wrong attempts', async () => {
    await powerHandler({ action: 'shutdown', delaySec: 600 });
    const sentText = JSON.parse(pushCalls[0].init.body).text;
    const goodNonce = sentText.match(/批准请直接回复数字 (\d{3})/)[1];
    const badNonce = goodNonce === '999' ? '998' : '999';

    for (let i = 0; i < 3; i++) {
      const r = await confirmHandler({ token: badNonce });
      assert.equal(parseResult(r).status, 'confirm_failed');
    }
    // Op is now burned — even the correct nonce is rejected
    const r = await confirmHandler({ token: goodNonce });
    assert.equal(parseResult(r).status, 'confirm_failed');
  });

  it('nonce path ignores 6-char chat tokens (no cross-talk)', async () => {
    const { token } = pending.createPending({
      operation: { kind: 'service', action: 'start', name: 'gca-fake-svc-gap' },
      reason: 'test',
    });
    const result = await confirmHandler({ token });
    assert.notEqual(parseResult(result).status, 'confirm_failed');
  });
});
