/**
 * Tests for the file_list tool.
 *
 * Uses a real temp-directory fixture so the handler is exercised end to end:
 *   fixture/
 *   ├── a.txt          ("hello")
 *   ├── b.pdf          (empty)
 *   └── sub/
 *       ├── c.txt
 *       └── deep/
 *           └── d.log
 *
 * Verifies listing, type detection, wildcard filtering, recursion,
 * and graceful error handling for bad paths.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileListHandler, wildcardToRegex } from '../src/tools/file-list/handler.js';

interface HandlerResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parse(result: HandlerResult) {
  return JSON.parse(result.content[0].text);
}

let fixture: string;

before(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'gca-file-list-'));
  await writeFile(path.join(fixture, 'a.txt'), 'hello');
  await writeFile(path.join(fixture, 'b.pdf'), '');
  await mkdir(path.join(fixture, 'sub', 'deep'), { recursive: true });
  await writeFile(path.join(fixture, 'sub', 'c.txt'), 'nested');
  await writeFile(path.join(fixture, 'sub', 'deep', 'd.log'), 'log');
});

after(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('wildcardToRegex', () => {
  it('matches star wildcard', () => {
    const re = wildcardToRegex('*.txt');
    assert.ok(re.test('a.txt'));
    assert.ok(!re.test('b.pdf'));
  });

  it('matches question mark wildcard', () => {
    const re = wildcardToRegex('?.txt');
    assert.ok(re.test('a.txt'));
    assert.ok(!re.test('ab.txt'));
  });

  it('escapes regex special characters', () => {
    const re = wildcardToRegex('file+v1.2.txt');
    assert.ok(re.test('file+v1.2.txt'));
    assert.ok(!re.test('fileXv1X2.txt'));
  });

  it('anchors the whole name', () => {
    const re = wildcardToRegex('a.txt');
    assert.ok(!re.test('xa.txt'));
    assert.ok(!re.test('a.txtx'));
  });
});

describe('fileListHandler - basic listing', () => {
  it('lists top-level entries', async () => {
    const result = parse(await fileListHandler({ path: fixture }));
    assert.equal(result.status, 'ok');
    const names = result.entries.map((e: { name: string }) => e.name);
    assert.deepEqual(new Set(names), new Set(['a.txt', 'b.pdf', 'sub']));
    assert.equal(result.totalEntries, 3);
    assert.equal(result.truncated, false);
  });

  it('reports entry types', async () => {
    const result = parse(await fileListHandler({ path: fixture }));
    const sub = result.entries.find((e: { name: string }) => e.name === 'sub');
    const aTxt = result.entries.find((e: { name: string }) => e.name === 'a.txt');
    assert.equal(sub.type, 'directory');
    assert.equal(aTxt.type, 'file');
  });

  it('includes file size', async () => {
    const result = parse(await fileListHandler({ path: fixture }));
    const aTxt = result.entries.find((e: { name: string }) => e.name === 'a.txt');
    assert.equal(aTxt.size, 5);
  });

  it('sorts directories before files', async () => {
    const result = parse(await fileListHandler({ path: fixture }));
    assert.equal(result.entries[0].type, 'directory');
  });
});

describe('fileListHandler - pattern filter', () => {
  it('filters by wildcard', async () => {
    const result = parse(await fileListHandler({ path: fixture, pattern: '*.txt' }));
    const names = result.entries.map((e: { name: string }) => e.name);
    assert.deepEqual(names, ['a.txt']);
  });

  it('echoes the pattern in the response', async () => {
    const result = parse(await fileListHandler({ path: fixture, pattern: '*.pdf' }));
    assert.equal(result.pattern, '*.pdf');
    assert.equal(result.totalEntries, 1);
  });
});

describe('fileListHandler - recursion', () => {
  it('lists nested files when recursive', async () => {
    const result = parse(await fileListHandler({ path: fixture, recursive: true }));
    const paths = result.entries.map((e: { path: string }) => e.path);
    assert.ok(paths.some((p: string) => p.endsWith(path.join('sub', 'c.txt'))));
    assert.ok(paths.some((p: string) => p.endsWith(path.join('sub', 'deep', 'd.log'))));
    assert.equal(result.totalEntries, 6);
  });

  it('does not list nested files without recursive', async () => {
    const result = parse(await fileListHandler({ path: fixture }));
    const names = result.entries.map((e: { name: string }) => e.name);
    assert.ok(!names.includes('c.txt'));
    assert.ok(!names.includes('d.log'));
  });

  it('pattern still finds nested matches when recursive', async () => {
    const result = parse(await fileListHandler({ path: fixture, pattern: '*.log', recursive: true }));
    assert.equal(result.totalEntries, 1);
    assert.equal(result.entries[0].name, 'd.log');
  });
});

describe('fileListHandler - error handling', () => {
  it('returns graceful error for nonexistent path', async () => {
    const raw: HandlerResult = await fileListHandler({ path: path.join(fixture, 'no-such-dir') });
    const result = parse(raw);
    assert.equal(result.status, 'error');
    assert.equal(raw.isError, true);
  });

  it('returns graceful error when path is a file', async () => {
    const raw: HandlerResult = await fileListHandler({ path: path.join(fixture, 'a.txt') });
    const result = parse(raw);
    assert.equal(result.status, 'error');
    assert.match(result.error, /not a directory/i);
    assert.equal(raw.isError, true);
  });
});
