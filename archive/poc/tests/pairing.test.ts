/**
 * Tests for pairing (bearer-token auth on MCP endpoints).
 * Env redirected BEFORE dynamic imports (settings path computed per call).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const testRoot = join(tmpdir(), `gca-pairing-test-${process.pid}`);
process.env.GCA_SETTINGS_PATH = join(testRoot, 'settings.json');
delete process.env.GCA_MCP_TOKEN;

const pairing = await import('../src/services/pairing.js');
const settings = await import('../src/services/settings-store.js');

/** Minimal mock req/res/next harness for the middleware. */
function runMiddleware(headers = {}) {
  return new Promise((resolve) => {
    const req = { headers, path: '/mcp', ip: '127.0.0.1' };
    let status = null;
    let body = null;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; resolve({ status, body, next: false }); },
    };
    const middleware = pairing.requirePairing();
    middleware(req, res, () => resolve({ status: null, body: null, next: true }));
  });
}

before(async () => {
  await mkdir(testRoot, { recursive: true });
});

after(async () => {
  delete process.env.GCA_MCP_TOKEN;
  await rm(testRoot, { recursive: true, force: true });
});

describe('pairing', () => {
  it('open mode: no token configured → requests pass', async () => {
    assert.equal(await pairing.getPairingToken(), null);
    const r = await runMiddleware();
    assert.equal(r.next, true);
  });

  it('configured token: missing header → 401', async () => {
    await settings.setSetting('security.mcpToken', 'test-token-123');
    const r = await runMiddleware();
    assert.equal(r.status, 401);
    assert.equal(r.next, false);
  });

  it('configured token: wrong token → 401', async () => {
    const r = await runMiddleware({ authorization: 'Bearer wrong' });
    assert.equal(r.status, 401);
  });

  it('configured token: correct token → pass', async () => {
    const r = await runMiddleware({ authorization: 'Bearer test-token-123' });
    assert.equal(r.next, true);
  });

  it('env token overrides settings', async () => {
    process.env.GCA_MCP_TOKEN = 'env-token';
    assert.equal(await pairing.getPairingToken(), 'env-token');
    const r = await runMiddleware({ authorization: 'Bearer env-token' });
    assert.equal(r.next, true);
    const r2 = await runMiddleware({ authorization: 'Bearer test-token-123' });
    assert.equal(r2.status, 401);
    delete process.env.GCA_MCP_TOKEN;
  });

  it('token generation is 64 hex chars and unique', () => {
    const a = pairing.generatePairingToken();
    const b = pairing.generatePairingToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });

  it('logPairingState never throws', async () => {
    await pairing.logPairingState();
  });
});
