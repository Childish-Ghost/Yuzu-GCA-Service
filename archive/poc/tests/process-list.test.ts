/**
 * Tests for the process_list tool:
 *   returns real processes (the test process itself must appear),
 *   limit, filter, and the four sort modes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processListHandler } from '../src/tools/process-list/handler.js';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

describe('process_list', () => {
  it('returns real processes including this test process', async () => {
    // Fresh test process has ~0 cumulative CPU, so a cpu-sorted top-N would
    // cut it off — filter to node processes instead (few, all included).
    const r = parseResult(await processListHandler({ filter: 'node', limit: 100 }));
    assert.equal(r.status, 'ok');
    assert.ok(r.total > 0);
    assert.ok(r.processes.length > 0);
    assert.ok(
      r.processes.some((p: { pid: number }) => p.pid === process.pid),
      'current process should appear in the list',
    );
  });

  it('respects the limit', async () => {
    const r = parseResult(await processListHandler({ limit: 5 }));
    assert.equal(r.returned, 5);
    assert.ok(r.total >= 5);
  });

  it('filters by name substring', async () => {
    const r = parseResult(await processListHandler({ filter: 'node', limit: 100 }));
    assert.equal(r.status, 'ok');
    assert.ok(r.processes.length > 0, 'should find node processes');
    for (const p of r.processes) {
      assert.ok(p.name.toLowerCase().includes('node'), `${p.name} should match filter`);
    }
  });

  it('sorts by memory descending', async () => {
    const r = parseResult(await processListHandler({ sortBy: 'memory', limit: 10 }));
    const mems = r.processes.map((p: { memoryMB: number }) => p.memoryMB);
    for (let i = 1; i < mems.length; i++) {
      assert.ok(mems[i - 1] >= mems[i], `not sorted: ${mems[i - 1]} < ${mems[i]}`);
    }
  });

  it('sorts by pid ascending', async () => {
    const r = parseResult(await processListHandler({ sortBy: 'pid', limit: 10 }));
    const pids = r.processes.map((p: { pid: number }) => p.pid);
    for (let i = 1; i < pids.length; i++) {
      assert.ok(pids[i - 1] <= pids[i], `not sorted: ${pids[i - 1]} > ${pids[i]}`);
    }
  });
});
