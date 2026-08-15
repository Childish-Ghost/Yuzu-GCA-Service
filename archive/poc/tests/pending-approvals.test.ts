/**
 * Tests for the approval confirmation closed loop:
 *   pending-approvals store (mint/consume/expiry/single-use, operation kinds)
 *   exec → confirmation_required + token → confirm → executed
 *   file_write / file_move → token → confirm → operation performed
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, readFile, stat } from 'node:fs/promises';
import {
  createPending,
  consumePending,
  clearPending,
} from '../src/services/pending-approvals.js';
import { execHandler } from '../src/tools/exec/handler.js';
import { confirmHandler } from '../src/tools/confirm/handler.js';
import { fileWriteHandler } from '../src/tools/file-write/handler.js';
import { fileMoveHandler } from '../src/tools/file-move/handler.js';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  const text = handlerReturn.content[0]?.text;
  assert.ok(text, 'handler should return text content');
  return JSON.parse(text);
}

describe('pending-approvals store', () => {
  beforeEach(() => {
    clearPending();
  });

  it('mints a 6-char token from the unambiguous alphabet', () => {
    const token = createPending({ operation: { kind: 'exec', command: 'mkdir foo' }, reason: 'test' }).token;
    assert.match(token, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });

  it('consumePending returns the stored entry', () => {
    const token = createPending({
      operation: { kind: 'exec', command: 'mkdir foo', cwd: 'D:\\' },
      reason: 'test',
    }).token;
    const entry = consumePending(token);
    assert.ok(entry);
    assert.equal(entry.operation.kind, 'exec');
    if (entry.operation.kind === 'exec') {
      assert.equal(entry.operation.command, 'mkdir foo');
      assert.equal(entry.operation.cwd, 'D:\\');
    }
  });

  it('token is single-use', () => {
    const token = createPending({ operation: { kind: 'exec', command: 'mkdir foo' }, reason: 'test' }).token;
    assert.ok(consumePending(token));
    assert.equal(consumePending(token), null);
  });

  it('unknown token returns null', () => {
    assert.equal(consumePending('ZZZZZZ'), null);
  });

  it('expired token returns null', () => {
    const token = createPending({ operation: { kind: 'exec', command: 'mkdir foo' }, reason: 'test' }).token;
    assert.equal(consumePending(token, -1), null);
  });

  it('clearPending removes all entries', () => {
    const token = createPending({ operation: { kind: 'exec', command: 'mkdir foo' }, reason: 'test' }).token;
    clearPending();
    assert.equal(consumePending(token), null);
  });
});

describe('exec → confirm closed loop', () => {
  beforeEach(() => {
    clearPending();
  });

  it('write command returns confirmation_required (token not exposed)', async () => {
    // `mkdir` modifies state → classified as write
    const result = parseResult(await execHandler({ command: 'mkdir gca-test-unit' }));
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.executed, false);
    assert.equal(result.confirmToken, undefined);
    assert.equal(result.expiresInSec, 300);
  });

  it('confirmed command executes and reports confirmedByUser', async () => {
    const dir = join(tmpdir(), `gca-test-${process.pid}`);
    const pendingResult = parseResult(await execHandler({ command: `mkdir ${dir}` }));
    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'executed');
    assert.equal(confirmed.confirmedByUser, true);
    assert.equal(confirmed.exitCode, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it('confirming with an already-used token fails', async () => {
    const dir = join(tmpdir(), `gca-test-reuse-${process.pid}`);
    const pendingResult = parseResult(await execHandler({ command: `mkdir ${dir}` }));
    await confirmHandler({});
    const second = await confirmHandler({});
    assert.equal(second.isError, true);
    assert.equal(parseResult(second).status, 'confirm_failed');
    await rm(dir, { recursive: true, force: true });
  });

  it('confirming with an unknown token fails', async () => {
    const result = await confirmHandler({ token: 'ZZZZZZ' });
    assert.equal(result.isError, true);
    assert.equal(parseResult(result).status, 'confirm_failed');
  });

  it('blocked commands never mint a token', async () => {
    const result = parseResult(await execHandler({ command: 'rm -rf /' }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.confirmToken, undefined);
  });

  it('bare confirm (no token) executes the latest pending write op', async () => {
    const dir = join(tmpdir(), `gca-bare-${process.pid}`);
    await execHandler({ command: `mkdir ${dir}` });
    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'executed');
    assert.equal(confirmed.confirmedByUser, true);
    await rm(dir, { recursive: true, force: true });
  });

  it('bare confirm with nothing pending → confirm_failed', async () => {
    const result = await confirmHandler({});
    assert.equal(parseResult(result).status, 'confirm_failed');
  });
});

describe('file_write / file_move → confirm closed loop', () => {
  beforeEach(() => {
    clearPending();
  });

  it('file_write never writes inline — returns confirmation_required + token', async () => {
    const target = join(tmpdir(), `gca-fw-${process.pid}.txt`);
    const result = parseResult(await fileWriteHandler({ path: target, content: 'hello' }));
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.operation, 'file_write');
    assert.equal(result.confirmToken, undefined);
    // file must NOT exist yet
    await assert.rejects(stat(target));
  });

  it('confirmed file_write writes the file with confirmedByUser', async () => {
    const target = join(tmpdir(), `gca-fw-${process.pid}.txt`);
    const pendingResult = parseResult(await fileWriteHandler({ path: target, content: 'hello gca' }));
    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'written');
    assert.equal(confirmed.confirmedByUser, true);
    assert.equal(await readFile(target, 'utf8'), 'hello gca');
    await rm(target, { force: true });
  });

  it('confirmed file_write append mode appends', async () => {
    const target = join(tmpdir(), `gca-fw-app-${process.pid}.txt`);
    const first = parseResult(await fileWriteHandler({ path: target, content: 'aaa' }));
    await confirmHandler({});
    const second = parseResult(await fileWriteHandler({ path: target, content: 'bbb', mode: 'append' }));
    await confirmHandler({});
    assert.equal(await readFile(target, 'utf8'), 'aaabbb');
    await rm(target, { force: true });
  });

  it('confirmed file_move moves the file', async () => {
    const src = join(tmpdir(), `gca-fm-src-${process.pid}.txt`);
    const dest = join(tmpdir(), `gca-fm-dst-${process.pid}.txt`);
    const writeReq = parseResult(await fileWriteHandler({ path: src, content: 'move me' }));
    await confirmHandler({});

    const moveReq = parseResult(await fileMoveHandler({ source: src, dest }));
    assert.equal(moveReq.status, 'confirmation_required');
    assert.equal(moveReq.operation, 'file_move');

    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'moved');
    assert.equal(confirmed.confirmedByUser, true);
    assert.equal(await readFile(dest, 'utf8'), 'move me');
    await assert.rejects(stat(src));
    await rm(dest, { force: true });
  });
});
