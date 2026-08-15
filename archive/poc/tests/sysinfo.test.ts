/**
 * Tests for the sysinfo tool.
 *
 * sysinfo reads the real host, so assertions check structural invariants
 * rather than exact values (which vary by machine).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sysinfoHandler } from '../src/tools/sysinfo/handler.js';

interface HandlerResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('sysinfoHandler', () => {
  it('returns a well-formed snapshot', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    assert.equal(result.status, 'ok');
    assert.equal(raw.isError, undefined);
    assert.ok(result.hostname.length > 0);
    assert.ok(['win32', 'linux', 'darwin'].includes(result.os.platform));
    assert.ok(result.os.uptimeHours >= 0);
  });

  it('reports sane CPU information', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    assert.ok(result.cpu.cores >= 1);
    assert.ok(typeof result.cpu.model === 'string');
    assert.ok(Array.isArray(result.cpu.loadAvg));
    assert.equal(result.cpu.loadAvg.length, 3);
  });

  it('reports sane memory information', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    assert.ok(result.memory.totalMB > 0);
    assert.ok(result.memory.freeMB >= 0);
    assert.ok(result.memory.usedPercent >= 0 && result.memory.usedPercent <= 100);
    // Components are rounded independently — allow 1MB tolerance
    assert.ok(
      Math.abs(result.memory.usedMB + result.memory.freeMB - result.memory.totalMB) <= 1,
    );
  });

  it('reports disk information for the current volume', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    assert.ok(result.disk, 'disk section should exist');
    if (!result.disk.error) {
      assert.ok(result.disk.totalGB > 0);
      assert.ok(result.disk.freeGB >= 0);
      assert.ok(result.disk.usedPercent >= 0 && result.disk.usedPercent <= 100);
    }
  });

  it('reports network interfaces with valid IPv4 addresses', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    assert.ok(Array.isArray(result.network));
    for (const iface of result.network) {
      assert.match(iface.address, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      assert.ok(!iface.address.startsWith('127.'), 'should not include loopback');
    }
  });

  it('includes a parseable collection timestamp', async () => {
    const raw: HandlerResult = await sysinfoHandler();
    const result = JSON.parse(raw.content[0].text);

    const ts = new Date(result.collectedAt);
    assert.ok(!Number.isNaN(ts.getTime()));
    assert.ok(Date.now() - ts.getTime() < 60_000, 'timestamp should be fresh');
  });
});
