/**
 * Tests for the file_read tool:
 *   happy path, line ranges, binary refusal, missing path,
 *   not-a-file refusal, invalid range, line cap
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileReadHandler } from '../src/tools/file-read/handler.js';

const testDir = join(tmpdir(), `gca-fileread-test-${process.pid}`);
const textFile = join(testDir, 'sample.txt');
const binaryFile = join(testDir, 'blob.bin');
const manyLinesFile = join(testDir, 'many.txt');

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

before(async () => {
  await mkdir(testDir, { recursive: true });
  await writeFile(textFile, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  await writeFile(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  await writeFile(manyLinesFile, Array.from({ length: 5000 }, (_, i) => `row${i + 1}`).join('\n'), 'utf8');
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('file_read', () => {
  it('reads a whole file', async () => {
    const r = parseResult(await fileReadHandler({ path: textFile }));
    assert.equal(r.status, 'ok');
    assert.equal(r.totalLines, 6); // trailing newline produces a final empty line
    assert.ok(r.content.includes('line1'));
    assert.ok(r.content.includes('line5'));
    assert.equal(r.truncated, false);
  });

  it('honors a line range', async () => {
    const r = parseResult(await fileReadHandler({ path: textFile, startLine: 2, endLine: 4 }));
    assert.equal(r.startLine, 2);
    assert.equal(r.endLine, 4);
    assert.equal(r.content, 'line2\nline3\nline4');
  });

  it('clamps startLine beyond EOF', async () => {
    const r = parseResult(await fileReadHandler({ path: textFile, startLine: 999 }));
    assert.equal(r.status, 'ok');
    assert.equal(r.startLine, r.totalLines);
  });

  it('rejects endLine < startLine', async () => {
    const r = parseResult(await fileReadHandler({ path: textFile, startLine: 4, endLine: 2 }));
    assert.equal(r.status, 'error');
  });

  it('refuses binary files', async () => {
    const r = parseResult(await fileReadHandler({ path: binaryFile }));
    assert.equal(r.status, 'error');
    assert.match(r.error, /binary/i);
  });

  it('refuses missing paths', async () => {
    const r = parseResult(await fileReadHandler({ path: join(testDir, 'nope.txt') }));
    assert.equal(r.status, 'error');
  });

  it('refuses directories', async () => {
    const r = parseResult(await fileReadHandler({ path: testDir }));
    assert.equal(r.status, 'error');
  });

  it('caps output at 4000 lines and sets truncated', async () => {
    const r = parseResult(await fileReadHandler({ path: manyLinesFile }));
    assert.equal(r.status, 'ok');
    assert.equal(r.truncated, true);
    assert.equal(r.endLine - r.startLine + 1, 4000);
  });
});
