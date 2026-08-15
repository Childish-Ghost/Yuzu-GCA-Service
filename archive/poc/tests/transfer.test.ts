/**
 * Tests for cross-device file transfer (C-007):
 *   tickets (mint/consume/expiry) / file_serve confirm flow /
 *   transfer endpoint / file_fetch confirm flow with a real local server
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

process.env.GCA_SETTINGS_PATH = join(tmpdir(), `gca-transfer-test-${process.pid}`, 'settings.json');

const tickets = await import('../src/services/transfer-tickets.js');
const pending = await import('../src/services/pending-approvals.js');
const { fileServeHandler } = await import('../src/tools/file-serve/handler.js');
const { fileFetchHandler } = await import('../src/tools/file-fetch/handler.js');
const { confirmHandler } = await import('../src/tools/confirm/handler.js');
const { createSseServer } = await import('../src/transport/sse-transport.js');

const testRoot = join(tmpdir(), `gca-transfer-test-${process.pid}`);
const srcFile = join(testRoot, 'payload.txt');
const dstFile = join(testRoot, 'downloaded.txt');
const CONTENT = 'cross-device payload 中文内容 12345';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

let server: Server;
let baseUrl = '';

before(async () => {
  await mkdir(testRoot, { recursive: true });
  await writeFile(srcFile, CONTENT, 'utf8');
  const app = createSseServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  server?.close();
  await rm(testRoot, { recursive: true, force: true });
});

describe('transfer tickets', () => {
  it('mint + consume returns the ticket (single-use)', () => {
    const t = tickets.mintTicket('/tmp/x', 100);
    assert.equal(tickets.consumeTicket(t.token)?.path, '/tmp/x');
    assert.equal(tickets.consumeTicket(t.token), null);
  });

  it('unknown token returns null', () => {
    assert.equal(tickets.consumeTicket('nope'), null);
  });

  it('expired ticket returns null', () => {
    const t = tickets.mintTicket('/tmp/y', 100, -1);
    assert.equal(tickets.consumeTicket(t.token), null);
  });
});

describe('file_serve → transfer endpoint → file_fetch', () => {
  it('full flow: serve with confirm, download with confirm, bytes match', async () => {
    // Step 1: file_serve → confirmation_required
    const serveReq = parseResult(await fileServeHandler({ path: srcFile }));
    assert.equal(serveReq.status, 'confirmation_required');
    assert.equal(serveReq.operation, 'file_serve');

    // Step 2: confirm → serving + URL with ticket
    const served = parseResult(await confirmHandler({}));
    assert.equal(served.status, 'serving');
    assert.equal(served.confirmedByUser, true);
    assert.equal(served.size, Buffer.byteLength(CONTENT));
    const ticketToken = served.url.split('/transfer/')[1];
    assert.ok(ticketToken.length > 20);

    // Step 3: transfer endpoint serves the file once
    const transferUrl = `${baseUrl}/transfer/${ticketToken}`;
    const directRes = await fetch(transferUrl);
    assert.equal(directRes.status, 200);
    assert.equal(await directRes.text(), CONTENT);

    // Step 3b: ticket is single-use
    const replay = await fetch(transferUrl);
    assert.equal(replay.status, 404);

    // Step 4: file_fetch (needs a fresh ticket since the first was consumed)
    // Ticket URLs execute IMMEDIATELY — no second confirmation.
    const serveReq2 = parseResult(await fileServeHandler({ path: srcFile }));
    const served2 = parseResult(await confirmHandler({}));
    const fetched = parseResult(await fileFetchHandler({
      url: `${baseUrl}/transfer/${served2.url.split('/transfer/')[1]}`,
      targetPath: dstFile,
    }));
    assert.equal(fetched.status, 'fetched');
    assert.equal(fetched.sizeMatches, true);
    assert.equal(await readFile(dstFile, 'utf8'), CONTENT);
  });

  it('file_fetch with a burned ticket fails gracefully (immediate path)', async () => {
    const result = await fileFetchHandler({
      url: `${baseUrl}/transfer/definitely-not-a-ticket`,
      targetPath: join(testRoot, 'should-not-exist.bin'),
    });
    assert.equal(result.isError, true);
    assert.match(parseResult(result).error, /HTTP 404/);
  });

  it('file_fetch rejects non-http URLs', async () => {
    const r = await fileFetchHandler({ url: 'file:///etc/passwd', targetPath: dstFile });
    assert.equal(r.isError, true);
  });
});
