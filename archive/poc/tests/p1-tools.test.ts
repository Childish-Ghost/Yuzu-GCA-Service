/**
 * Tests for Phase 2 P1 tools:
 *   file_delete / exec_background / notify_send / power (OTP) / service (OTP)
 *
 * GCA_NOTIFY_CHANNEL=server-log is set by the test runner below so OTP
 * delivery never pops real dialogs during tests.
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import {
  createPending,
  consumePending,
  clearPending,
} from '../src/services/pending-approvals.js';
import { confirmHandler } from '../src/tools/confirm/handler.js';
import { fileDeleteHandler } from '../src/tools/file-delete/handler.js';
import { execBackgroundHandler } from '../src/tools/exec-background/handler.js';
import { notifySendHandler } from '../src/tools/notify-send/handler.js';
import { powerHandler } from '../src/tools/power/handler.js';
import { serviceHandler } from '../src/tools/service/handler.js';

process.env.GCA_NOTIFY_CHANNEL = 'server-log';
// No TOTP in this sandbox → power/service take the desktop-fallback OTP path
process.env.GCA_SECRETS_DIR = join(tmpdir(), `gca-p1-secrets-${process.pid}`);
// Point the GAP relay at a dead port so push attempts fail fast and never
// touch the real relay (no ghost pushes to the owner during tests)
process.env.GAP_RELAY_URL = 'http://127.0.0.1:1';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  clearPending();
});

describe('file_delete', () => {
  const target = join(tmpdir(), `gca-fd-${process.pid}.txt`);

  it('never deletes inline — returns confirmation_required', async () => {
    await writeFile(target, 'delete me', 'utf8');
    const r = parseResult(await fileDeleteHandler({ path: target }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.operation, 'file_delete');
    await stat(target); // still exists
    await rm(target, { force: true });
  });

  it('confirmed delete removes the file', async () => {
    await writeFile(target, 'delete me', 'utf8');
    const req = parseResult(await fileDeleteHandler({ path: target }));
    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'deleted');
    assert.equal(confirmed.confirmedByUser, true);
    await assert.rejects(stat(target));
  });

  it('refuses filesystem roots outright', async () => {
    // Portable root: C:\ on Windows, / on POSIX
    const root = parse(tmpdir()).root;
    const r = await fileDeleteHandler({ path: root, recursive: true });
    assert.equal(r.isError, true);
    assert.match(parseResult(r).error, /root/i);
  });
});

describe('exec_background', () => {
  it('readonly command starts immediately with a task record', async () => {
    const r = parseResult(await execBackgroundHandler({ command: 'echo gca-bg-probe' }));
    assert.equal(r.status, 'started');
    assert.match(r.taskId, /^T[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    assert.ok(r.pid > 0);
    await sleep(1200);
    const log = await readFile(r.logPath, 'utf8');
    assert.match(log, /gca-bg-probe/);
    await rm(r.logPath, { force: true });
  });

  it('write command requires confirmation, confirm starts the task', async () => {
    const dir = join(tmpdir(), `gca-bg-${process.pid}`);
    const req = parseResult(await execBackgroundHandler({ command: `mkdir ${dir}` }));
    assert.equal(req.status, 'confirmation_required');
    assert.equal(req.operation, 'exec_background');

    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'started');
    assert.equal(confirmed.confirmedByUser, true);
    await sleep(1200);
    await rm(dir, { recursive: true, force: true });
    await rm(confirmed.logPath, { force: true });
  });
});

describe('notify_send', () => {
  it('sends via the forced channel and reports it', async () => {
    const r = parseResult(await notifySendHandler({ message: 'unit test', title: 'GCA-Test' }));
    assert.equal(r.status, 'sent');
    assert.equal(r.channel, 'server-log');
    assert.equal(r.title, 'GCA-Test');
  });
});

describe('power — OTP flow', () => {
  it('shutdown requires OTP: no token in response, delivery set', async () => {
    const r = parseResult(await powerHandler({ action: 'shutdown', delaySec: 600 }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.operation, 'power');
    assert.equal(r.confirmToken, undefined, 'OTP code must NOT be exposed to the AI');
    assert.equal(r.delivery, 'server-log');
    assert.match(r.note, /device screen/i);
  });

  it('sleep/hibernate/restart also use OTP', async () => {
    for (const action of ['sleep', 'hibernate', 'restart'] as const) {
      clearPending();
      const r = parseResult(await powerHandler({ action }));
      assert.equal(r.confirmToken, undefined, `${action} must use OTP`);
      assert.equal(r.delivery, 'server-log');
    }
  });

  it('wol uses the chat-token flow and requires mac', async () => {
    const noMac = await powerHandler({ action: 'wol' });
    assert.equal(noMac.isError, true);

    const r = parseResult(await powerHandler({ action: 'wol', mac: 'AA:BB:CC:DD:EE:FF' }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.confirmToken, undefined);
  });

  it('abort executes immediately without confirmation (safety cancel)', async () => {
    // With no shutdown scheduled, shutdown /a exits nonzero — either a clean
    // 'ok' or a graceful error is acceptable; it must NOT require confirmation.
    const result = await powerHandler({ action: 'abort' });
    const parsed = parseResult(result);
    assert.ok(parsed.status === 'ok' || parsed.status === 'error');
    assert.notEqual(parsed.status, 'confirmation_required');
  });

  it('confirmed wol sends the packet (harmless broadcast)', async () => {
    const r = parseResult(await powerHandler({ action: 'wol', mac: 'AA:BB:CC:DD:EE:FF' }));
    const confirmed = parseResult(await confirmHandler({}));
    assert.equal(confirmed.status, 'ok');
    assert.equal(confirmed.confirmedByUser, true);
  });

  it('confirmed power shutdown dispatch is wired (fails safe on fake delay? no — never test real shutdown)', async () => {
    // Directly seed a pending power op with an invalid action path via sleep? Skip dangerous.
    // Instead verify the dispatch of an unknown-but-valid op kind through createPending + confirm.
    const token = createPending({
      operation: { kind: 'power', action: 'wol', mac: 'AA:BB:CC:DD:EE:FF' },
      reason: 'test',
    }).token;
    const confirmed = parseResult(await confirmHandler({ token }));
    assert.equal(confirmed.status, 'ok');
  });
});

describe('service — list + OTP flow', () => {
  it('list returns services (auto-approved)', async () => {
    const r = parseResult(await serviceHandler({ action: 'list', limit: 10 }));
    assert.equal(r.status, 'ok');
    assert.ok(r.services.length > 0);
    assert.ok(r.services[0].name);
  });

  it('start without name errors', async () => {
    const r = await serviceHandler({ action: 'start' });
    assert.equal(r.isError, true);
  });

  it('start requires OTP: no token exposed', async () => {
    const r = parseResult(await serviceHandler({ action: 'restart', name: 'wuauserv' }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.operation, 'service');
    assert.equal(r.confirmToken, undefined);
    assert.equal(r.delivery, 'server-log');
  });

  it('confirmed service action on a fake service fails gracefully', async () => {
    const token = createPending({
      operation: { kind: 'service', action: 'start', name: 'gca-fake-svc-12345' },
      reason: 'test',
    }).token;
    const result = await confirmHandler({ token });
    assert.equal(result.isError, true);
    assert.match(parseResult(result).error, /./); // has an error message, no crash
  });
});
