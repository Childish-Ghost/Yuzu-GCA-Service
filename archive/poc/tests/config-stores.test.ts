/**
 * Tests for P-011 / C-016 infrastructure:
 *   settings-store (JSON, atomic write) / credential-store (DPAPI) / proxy resolution
 *
 * Env paths are redirected to a temp dir BEFORE dynamically importing the
 * modules under test (both compute their paths at module load).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const testRoot = join(tmpdir(), `gca-stores-test-${process.pid}`);
const settingsFile = join(testRoot, 'settings.json');
const secretsDir = join(testRoot, 'secrets');

process.env.GCA_SETTINGS_PATH = settingsFile;
process.env.GCA_SECRETS_DIR = secretsDir;
// Deterministic proxy env for this test process — config.ts reads env at
// module load, so these must be set BEFORE the dynamic imports below.
// NOTE: Windows env vars are CASE-INSENSITIVE — delete lowercase aliases
// FIRST, then set the uppercase ones (deleting http_proxy afterwards
// would delete HTTP_PROXY too).
delete process.env.SOCKS_PROXY;
delete process.env.NO_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.socks_proxy;
delete process.env.no_proxy;
process.env.HTTP_PROXY = 'http://env-http:8080';
process.env.HTTPS_PROXY = 'http://env-https:8443';

const settings = await import('../src/services/settings-store.js');
const credentials = await import('../src/services/credential-store.js');
const proxy = await import('../src/services/proxy.js');

before(async () => {
  await mkdir(testRoot, { recursive: true });
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('settings-store', () => {
  it('starts empty on first run', async () => {
    assert.equal(await settings.getSetting('nonexistent'), undefined);
  });

  it('sets and gets a value, persisted to disk', async () => {
    await settings.setSetting('device.nickname', 'Childish-Ghost');
    assert.equal(await settings.getSetting('device.nickname'), 'Childish-Ghost');
    const onDisk = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(onDisk['device.nickname'], 'Childish-Ghost');
  });

  it('overwrites and deletes', async () => {
    await settings.setSetting('k', 'v1');
    await settings.setSetting('k', 'v2');
    assert.equal(await settings.getSetting('k'), 'v2');
    await settings.deleteSetting('k');
    assert.equal(await settings.getSetting('k'), undefined);
  });

  it('getAllSettings returns a snapshot', async () => {
    await settings.setSetting('a', 1);
    const all = await settings.getAllSettings();
    assert.equal(all.a, 1);
  });
});

describe('credential-store (DPAPI)', () => {
  it('stores ciphertext, never plaintext', async () => {
    await credentials.setSecret('test-key', 'super-secret-value-123');
    const names = await credentials.listSecretNames();
    assert.ok(names.includes('test-key'));
    const raw = await readFile(join(secretsDir, 'test-key.bin'), 'utf8');
    if (process.platform === 'win32') {
      assert.ok(!raw.includes('super-secret-value-123'), 'secret must not appear in the stored file');
    } else {
      // file-perm mode (Linux/macOS): plaintext is by design — protection is
      // the 0o600 file mode, same model as ~/.aws/credentials
      const { stat } = await import('node:fs/promises');
      const s = await stat(join(secretsDir, 'test-key.bin'));
      assert.equal(s.mode & 0o777, 0o600, 'secret file must be owner-only (600)');
    }
  });

  it('round-trips a secret', async () => {
    await credentials.setSecret('round-trip', 'P@ssw0rd!中文');
    assert.equal(await credentials.getSecret('round-trip'), 'P@ssw0rd!中文');
  });

  it('returns null for unknown names', async () => {
    assert.equal(await credentials.getSecret('never-stored'), null);
  });

  it('deletes secrets', async () => {
    await credentials.setSecret('to-delete', 'x');
    assert.equal(await credentials.deleteSecret('to-delete'), true);
    assert.equal(await credentials.getSecret('to-delete'), null);
    assert.equal(await credentials.deleteSecret('to-delete'), false);
  });

  it('rejects invalid names', async () => {
    await assert.rejects(credentials.setSecret('../evil', 'x'), /Invalid secret name/);
  });
});

describe('proxy resolution', () => {
  it('isBypassed: exact, suffix, wildcard', () => {
    assert.equal(proxy.isBypassed('example.com', ['example.com']), true);
    assert.equal(proxy.isBypassed('api.example.com', ['example.com']), true);
    assert.equal(proxy.isBypassed('anything.io', ['*']), true);
    assert.equal(proxy.isBypassed('other.org', ['example.com']), false);
  });

  it('env proxy applies when no settings value', async () => {
    // env was set before module load: HTTP_PROXY / HTTPS_PROXY
    assert.equal(await proxy.getProxyForUrl('http://example.com/'), 'http://env-http:8080');
    assert.equal(await proxy.getProxyForUrl('https://secure.example.com/'), 'http://env-https:8443');
  });

  it('settings-file proxy wins over env', async () => {
    await settings.setSetting('proxy.http', 'http://file-proxy:3128');
    assert.equal(await proxy.getProxyForUrl('http://example.com/'), 'http://file-proxy:3128');
    // https has no settings value → still env
    assert.equal(await proxy.getProxyForUrl('https://secure.example.com/'), 'http://env-https:8443');
    await settings.deleteSetting('proxy.http');
  });

  it('NO_PROXY bypass beats everything', async () => {
    await settings.setSetting('proxy.bypass', ['internal.corp']);
    assert.equal(await proxy.getProxyForUrl('https://app.internal.corp/'), null);
    assert.equal(await proxy.getProxyForUrl('https://external.com/'), 'http://env-https:8443');
    await settings.deleteSetting('proxy.bypass');
  });
});
