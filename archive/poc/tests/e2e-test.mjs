/**
 * POC End-to-End Test Script
 *
 * Tests the MCP Server SSE + Tool calling chain WITHOUT OpenClaw.
 * Simulates what OpenClaw would do:
 *   1. Connect to /sse, get sessionId
 *   2. POST JSON-RPC initialize request
 *   3. POST JSON-RPC tools/list request (verify exec is registered)
 *   4. POST JSON-RPC tools/call request (verify exec works with readonly command)
 *   5. POST tools/call with dangerous command (verify blocking)
 *   6. POST tools/call with write command (verify confirmation_required + confirmToken)
 *   7. POST exec_confirm with the token (verify confirmed execution)
 *   8. POST exec_confirm with a bogus token (verify confirm_failed)
 *   9. Check /health endpoint
 *
 * Usage:
 *   1. Start POC server:  cd poc && npm run dev
 *   2. Run this test:     node poc/tests/e2e-test.mjs
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE_URL = process.env.POC_URL || 'http://localhost:3001';

// Pairing: when the server has a token (settings.json or env), attach it
let pairingToken = process.env.GCA_MCP_TOKEN || null;
if (!pairingToken) {
  try {
    const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
    pairingToken = settings['security.mcpToken'] ?? null;
  } catch {}
}
const authHeaders = pairingToken ? { Authorization: `Bearer ${pairingToken}` } : {};

let passed = 0;
let failed = 0;
const results = [];

function log(name, success, detail) {
  const icon = success ? '[OK]' : '[XX]';
  console.log(`${icon} ${name} — ${success ? 'PASS' : 'FAIL'}`);
  if (detail) console.log(`     ${detail}`);
  results.push({ name, success, detail });
  if (success) passed++;
  else failed++;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== GCA POC E2E Test ===\n');
  console.log(`Target: ${BASE_URL}\n`);

  // --- Step 0: Health check ---
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    log('Health check',
      res.ok && data.status === 'ok',
      `status=${data.status}, device=${data.device}`);
  } catch (err) {
    log('Health check', false, err.message);
    console.log('\nMake sure POC server is running: cd poc && npm run dev');
    process.exit(1);
  }

  // --- Step 1: Connect to SSE, get sessionId ---
  let sessionId = null;
  let sseResponse = null;
  let reader = null;
  let decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    sseResponse = await fetch(`${BASE_URL}/sse`, {
      headers: { Accept: 'text/event-stream', ...authHeaders },
    });

    if (!sseResponse.ok) {
      throw new Error(`SSE returned ${sseResponse.status}`);
    }

    reader = sseResponse.body.getReader();

    // Read first event to get sessionId
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed immediately');

    sseBuffer += decoder.decode(value, { stream: true });

    // Parse for sessionId
    for (const line of sseBuffer.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        const match = data.match(/sessionId=([a-f0-9-]+)/);
        if (match) {
          sessionId = match[1];
          break;
        }
      }
    }

    log('SSE connection + sessionId',
      sessionId !== null,
      `sessionId=${sessionId ? sessionId.substring(0, 8) + '...' : 'null'}`);
  } catch (err) {
    log('SSE connection + sessionId', false, err.message);
    printResults();
    process.exit(1);
  }

  if (!sessionId) {
    log('SSE connection + sessionId', false, 'Could not extract sessionId');
    printResults();
    process.exit(1);
  }

  // --- Helper: send JSON-RPC via POST /messages ---
  let rpcId = 0;
  async function sendRpc(method, params) {
    rpcId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method,
      params,
    });

    const res = await fetch(`${BASE_URL}/messages?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /messages returned ${res.status}: ${text}`);
    }

    // Response may be empty (SSE transport sends result via stream)
    return res;
  }

  // --- Helper: read next JSON-RPC response from SSE stream ---
  async function readSseResponse(timeoutMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check if we already have a complete response in buffer
      for (const line of sseBuffer.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          try {
            const parsed = JSON.parse(data);
            if (parsed.jsonrpc === '2.0' && parsed.id !== undefined) {
              // Remove this line from buffer
              const idx = sseBuffer.indexOf(line);
              sseBuffer = sseBuffer.slice(idx + line.length + 1);
              return parsed;
            }
          } catch {
            // Not JSON-RPC, skip
          }
        }
      }

      // Read more from stream
      const { done, value } = await reader.read();
      if (done) {
        // Stream closed
        return null;
      }
      sseBuffer += decoder.decode(value, { stream: true });
    }

    return null; // timeout
  }

  // Wait for SSE to stabilize
  await sleep(500);

  // --- Step 2: Initialize MCP connection ---
  try {
    await sendRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;

    log('MCP initialize',
      result !== null && result !== undefined,
      result ? `protocol=${result.protocolVersion || 'ok'}` : 'no response');
  } catch (err) {
    log('MCP initialize', false, err.message);
  }

  await sleep(300);

  // --- Step 3: List tools ---
  try {
    await sendRpc('tools/list', {});
    const response = await readSseResponse(5000);
    const result = response?.result;
    const tools = result?.tools || [];
    const hasExec = tools.some(t => t.name === 'exec');

    log('tools/list — 20 tools registered',
      tools.length === 20 && hasExec && tools.some(t => t.name === 'confirm'),
      `tools=[${tools.map(t => t.name).join(', ')}]`);
  } catch (err) {
    log('tools/list — 20 tools registered', false, err.message);
  }

  await sleep(300);

  // --- Step 4: exec readonly command ---
  try {
    await sendRpc('tools/call', {
      name: 'exec',
      arguments: { command: 'echo hello-from-poc' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('exec readonly (echo hello-from-poc)',
      parsed?.status === 'executed' && parsed?.stdout?.includes('hello-from-poc'),
      `status=${parsed?.status}, stdout=${parsed?.stdout?.trim()}`);
  } catch (err) {
    log('exec readonly (echo hello-from-poc)', false, err.message);
  }

  await sleep(300);

  // --- Step 5: exec dangerous command ---
  try {
    await sendRpc('tools/call', {
      name: 'exec',
      arguments: { command: 'rm -rf /' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('exec dangerous (rm -rf /) — blocked',
      parsed?.status === 'blocked' && parsed?.executed === false,
      `status=${parsed?.status}, reason=${parsed?.reason}`);
  } catch (err) {
    log('exec dangerous (rm -rf /) — blocked', false, err.message);
  }

  await sleep(300);

  // --- Step 6: exec write command ---
  const confirmDir = join(tmpdir(), `gca-e2e-confirm-${process.pid}`);
  let writeToken = null;
  try {
    await sendRpc('tools/call', {
      name: 'exec',
      arguments: { command: `mkdir ${confirmDir}` },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    writeToken = true;

    log('exec write (mkdir) — confirmation_required (token not exposed)',
      parsed?.status === 'confirmation_required' && parsed?.executed === false
        && parsed?.confirmToken === undefined,
      `status=${parsed?.status}, confirmToken=${parsed?.confirmToken}`);
  } catch (err) {
    log('exec write (mkdir) — confirmation_required', false, err.message);
  }

  await sleep(300);

  // --- Step 7: confirm with the token (user approved via chat) ---
  try {
    if (!writeToken) throw new Error('no confirmToken from previous step');

    await sendRpc('tools/call', {
      name: 'confirm',
      arguments: {},
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('confirm (user approved) — executed',
      parsed?.status === 'executed' && parsed?.confirmedByUser === true && parsed?.exitCode === 0,
      `status=${parsed?.status}, confirmedByUser=${parsed?.confirmedByUser}, exitCode=${parsed?.exitCode}`);

    rmSync(confirmDir, { recursive: true, force: true });
  } catch (err) {
    log('confirm (user approved) — executed', false, err.message);
    rmSync(confirmDir, { recursive: true, force: true });
  }

  await sleep(300);

  // --- Step 8: confirm with a bogus token ---
  try {
    await sendRpc('tools/call', {
      name: 'confirm',
      arguments: { token: 'ZZZZZZ' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('confirm bogus token — confirm_failed',
      parsed?.status === 'confirm_failed' && parsed?.executed === false,
      `status=${parsed?.status}, reason=${parsed?.reason?.substring(0, 60)}`);
  } catch (err) {
    log('confirm bogus token — confirm_failed', false, err.message);
  }

  await sleep(300);

  // --- Step 8b: file_read (write a probe file locally, read it via the tool) ---
  const probeFile = join(tmpdir(), `gca-e2e-read-${process.pid}.txt`);
  try {
    writeFileSync(probeFile, 'alpha\nbeta\ngamma\n', 'utf8');

    await sendRpc('tools/call', {
      name: 'file_read',
      arguments: { path: probeFile, startLine: 2, endLine: 3 },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('file_read with line range',
      parsed?.status === 'ok' && parsed?.content === 'beta\ngamma',
      `status=${parsed?.status}, lines=${parsed?.startLine}-${parsed?.endLine}, content=${JSON.stringify(parsed?.content)}`);

    rmSync(probeFile, { force: true });
  } catch (err) {
    log('file_read with line range', false, err.message);
    rmSync(probeFile, { force: true });
  }

  await sleep(300);

  // --- Step 8c: file_write → confirm → file exists on disk ---
  const writeTarget = join(tmpdir(), `gca-e2e-write-${process.pid}.txt`);
  try {
    await sendRpc('tools/call', {
      name: 'file_write',
      arguments: { path: writeTarget, content: 'written-by-e2e' },
    });

    let response = await readSseResponse(5000);
    let parsed = JSON.parse(response?.result?.content?.[0]?.text ?? 'null');
    if (parsed?.status !== 'confirmation_required') {
      throw new Error(`expected confirmation_required, got ${parsed?.status}`);
    }

    await sendRpc('tools/call', {
      name: 'confirm',
      arguments: {},
    });

    response = await readSseResponse(5000);
    parsed = JSON.parse(response?.result?.content?.[0]?.text ?? 'null');
    const onDisk = existsSync(writeTarget) ? readFileSync(writeTarget, 'utf8') : null;

    log('file_write → confirm → file on disk',
      parsed?.status === 'written' && parsed?.confirmedByUser === true && onDisk === 'written-by-e2e',
      `status=${parsed?.status}, onDisk=${JSON.stringify(onDisk)}`);

    rmSync(writeTarget, { force: true });
  } catch (err) {
    log('file_write → confirm → file on disk', false, err.message);
    rmSync(writeTarget, { force: true });
  }

  await sleep(300);

  // --- Step 8d: process_list returns processes ---
  try {
    await sendRpc('tools/call', {
      name: 'process_list',
      arguments: { sortBy: 'memory', limit: 5 },
    });

    const response = await readSseResponse(8000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('process_list sorted by memory',
      parsed?.status === 'ok' && parsed?.returned === 5 && parsed?.total > 5,
      `status=${parsed?.status}, returned=${parsed?.returned}, total=${parsed?.total}`);
  } catch (err) {
    log('process_list sorted by memory', false, err.message);
  }

  await sleep(300);

  // --- Step 8e: service list (read-only) ---
  try {
    await sendRpc('tools/call', {
      name: 'service',
      arguments: { action: 'list', limit: 3 },
    });

    const response = await readSseResponse(8000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('service list (read-only)',
      parsed?.status === 'ok' && parsed?.services?.length > 0,
      `status=${parsed?.status}, first=${parsed?.services?.[0]?.name}`);
  } catch (err) {
    log('service list (read-only)', false, err.message);
  }

  await sleep(300);

  // --- Step 8f: exec_background readonly ---
  try {
    await sendRpc('tools/call', {
      name: 'exec_background',
      arguments: { command: 'echo gca-e2e-bg' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    let logOk = false;
    if (parsed?.status === 'started') {
      await sleep(1200);
      logOk = existsSync(parsed.logPath) && readFileSync(parsed.logPath, 'utf8').includes('gca-e2e-bg');
      rmSync(parsed.logPath, { force: true });
    }

    log('exec_background readonly — started + log written',
      parsed?.status === 'started' && logOk,
      `status=${parsed?.status}, taskId=${parsed?.taskId}, logOk=${logOk}`);
  } catch (err) {
    log('exec_background readonly — started + log written', false, err.message);
  }

  await sleep(300);

  // --- Step 7: exec error command (BT-01) ---
  // Use a readonly command that will produce an error (cat nonexistent file)
  // Unknown commands default to 'write' (confirmation_required) — that's correct security behavior.
  // Here we test that a readonly command with a bad path returns a graceful error.
  try {
    await sendRpc('tools/call', {
      name: 'exec',
      arguments: { command: 'cat /nonexistent-file-12345' },
    });

    const response = await readSseResponse(5000);
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    // cat is readonly -> it will execute, but fail with nonzero exit code
    log('exec error (cat nonexistent file) — graceful error',
      parsed?.status === 'executed' && parsed?.exitCode !== 0,
      `status=${parsed?.status}, exitCode=${parsed?.exitCode}, stderr=${parsed?.stderr?.trim()?.substring(0, 80)}`);
  } catch (err) {
    log('exec error (cat nonexistent file) — graceful error', false, err.message);
  }

  // --- Cleanup SSE session ---
  try {
    reader.cancel();
  } catch {}

  // ================================================================
  // Streamable HTTP transport tests (/mcp endpoint)
  // ================================================================
  console.log('\n=== Streamable HTTP transport (/mcp) ===\n');

  // Helper: POST JSON-RPC to /mcp; responses arrive as SSE-formatted body
  let mcpRpcId = 100;
  async function postMcp(body, sessionId) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...authHeaders,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    });

    const text = await res.text();
    // SSE format: lines "data: {json}"; plain JSON also accepted
    let parsed = null;
    for (const line of text.split('\n')) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : null;
      if (data) {
        try { parsed = JSON.parse(data); } catch {}
      }
    }
    if (!parsed && text) {
      try { parsed = JSON.parse(text); } catch {}
    }
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: parsed };
  }

  // --- Step 9: initialize over streamable HTTP ---
  let mcpSessionId = null;
  try {
    mcpRpcId++;
    const res = await postMcp({
      id: mcpRpcId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    });
    mcpSessionId = res.sessionId;

    log('MCP initialize (streamable-http)',
      res.status === 200 && res.body?.result && mcpSessionId,
      `sessionId=${mcpSessionId ? mcpSessionId.substring(0, 8) + '...' : 'null'}`);
  } catch (err) {
    log('MCP initialize (streamable-http)', false, err.message);
  }

  // Initialized notification (spec-required follow-up)
  if (mcpSessionId) {
    await postMcp({ method: 'notifications/initialized' }, mcpSessionId);
    await sleep(200);
  }

  // --- Step 10: tools/list over streamable HTTP ---
  try {
    if (!mcpSessionId) throw new Error('no session from initialize');
    mcpRpcId++;
    const res = await postMcp({ id: mcpRpcId, method: 'tools/list', params: {} }, mcpSessionId);
    const tools = res.body?.result?.tools || [];

    log('tools/list (streamable-http)',
      tools.length === 20 && tools.some(t => t.name === 'confirm'),
      `tools=[${tools.map(t => t.name).join(', ')}]`);
  } catch (err) {
    log('tools/list (streamable-http)', false, err.message);
  }

  // --- Step 11: exec readonly over streamable HTTP ---
  try {
    if (!mcpSessionId) throw new Error('no session from initialize');
    mcpRpcId++;
    const res = await postMcp({
      id: mcpRpcId,
      method: 'tools/call',
      params: { name: 'exec', arguments: { command: 'echo hello-from-streamable' } },
    }, mcpSessionId);
    const text = res.body?.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;

    log('exec readonly (streamable-http)',
      parsed?.status === 'executed' && parsed?.stdout?.includes('hello-from-streamable'),
      `status=${parsed?.status}, stdout=${parsed?.stdout?.trim()}`);
  } catch (err) {
    log('exec readonly (streamable-http)', false, err.message);
  }

  // --- Step 12: DELETE session ---
  try {
    if (!mcpSessionId) throw new Error('no session from initialize');
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': mcpSessionId, ...authHeaders },
    });

    log('session DELETE (streamable-http)',
      res.status === 200,
      `status=${res.status}`);
  } catch (err) {
    log('session DELETE (streamable-http)', false, err.message);
  }

  printResults();
}

function printResults() {
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}/${passed + failed}`);
  console.log(`Failed: ${failed}/${passed + failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.name}: ${r.detail}`);
    });
  }

  console.log('');
  if (failed === 0) {
    console.log('All tests passed! MCP Server SSE + Tool chain is working.');
  } else {
    console.log('Some tests failed. Check the output above.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
