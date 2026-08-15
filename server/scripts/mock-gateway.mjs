#!/usr/bin/env node
/**
 * Mock OpenClaw Gateway — minimal WS server for local testing of the
 * OpenClawWsAdapter without a real Gateway. Zero dependencies (Node 22+).
 *
 * Implements just enough of the protocol v4 surface:
 *   connect.challenge → connect → hello-ok
 *   chat.send → { runId }
 *   agent.wait → terminal snapshot
 *   tick events every 15s
 *   optionally rejects connect when GATEWAY_REQUIRE_PAIRING=1 (device required)
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_GATEWAY_PORT) || 18789;
const REQUIRE_PAIRING = process.env.GATEWAY_REQUIRE_PAIRING === '1';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = http.createServer((req, res) => {
  res.writeHead(426);
  res.end('websocket only');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  console.log('[mock-gateway] client connected');

  let challengeSent = false;
  let connected = false;

  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  const sendChallenge = () => {
    if (challengeSent) return;
    challengeSent = true;
    send({ type: 'event', event: 'connect.challenge', payload: { nonce: `mock-nonce-${Date.now()}`, ts: Date.now() } });
  };

  // read frames
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return socket.destroy();
        len = Number(big); offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4); offset += 4;
      }
      if (buffer.length < offset + len) return;
      let data = Buffer.from(buffer.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < data.length; i++) data[i] ^= maskKey[i % 4];
      }
      buffer = buffer.subarray(offset + len);
      if (opcode === 0x9) { // ping → pong
        send({}); // simplified pong
        continue;
      }
      if (!fin) continue; // fragmentation unsupported
      const text = data.toString('utf8');
      console.log('[mock-gateway] frame opcode=' + opcode + ' len=' + len + ' text=' + text.slice(0, 120));
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { console.log('[mock-gateway] parse error:', e.message, 'hex=', data.subarray(0, 40).toString('hex')); return; }
      console.log('[mock-gateway] parsed type=' + parsed.type + ' method=' + (parsed.method ?? ''));
      handleFrame(parsed);
    }
  });

  function handleFrame(frame) {
    console.log('[mock-gateway] handleFrame type=' + frame.type + ' method=' + (frame.method ?? ''));
    if (frame.type === 'req' && frame.method === 'connect') {
      const params = frame.params || {};
      if (REQUIRE_PAIRING && !params.device) {
        send({ type: 'res', id: frame.id, ok: false, error: { code: 'DEVICE_REQUIRED', message: 'device identity required for pairing' } });
        return;
      }
      connected = true;
      send({
        type: 'res', id: frame.id, ok: true,
        payload: {
          type: 'hello-ok',
          protocol: 4,
          server: { version: 'mock-2026.7', connId: 'mock-conn-1' },
          features: { methods: ['chat.send', 'agent.wait'], events: ['tick', 'chat'] },
          snapshot: {},
          auth: { role: 'operator', scopes: params.scopes ?? ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'] },
          policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
        },
      });
      console.log('[mock-gateway] hello-ok sent, scopes:', (params.scopes ?? []).join(','));
      return;
    }
    if (frame.type === 'req' && frame.method === 'chat.send') {
      console.log('[mock-gateway] chat.send sessionKey=' + frame.params.sessionKey + ' message=' + String(frame.params.message).slice(0, 40));
      const runId = `mock-run-${Date.now()}`;
      send({ type: 'res', id: frame.id, ok: true, payload: { runId } });
      // simulate streaming chat events (delta accumulation → final with message)
      const reply = 'Mock reply: 收到你的消息了。这是模拟 Gateway 的回复。';
      let sent = 0;
      const interval = setInterval(() => {
        if (sent >= reply.length) {
          clearInterval(interval);
          send({
            type: 'event', event: 'chat',
            payload: { runId, sessionKey: frame.params.sessionKey, seq: 99, state: 'final', message: { role: 'assistant', text: reply } },
          });
          return;
        }
        const chunk = reply.slice(sent, sent + 8);
        sent += 8;
        send({ type: 'event', event: 'chat', payload: { runId, sessionKey: frame.params.sessionKey, seq: sent, state: 'delta', deltaText: chunk, message: { text: reply.slice(0, sent) } } });
      }, 100);
      return;
    }
    if (frame.type === 'req' && frame.method === 'agent.wait') {
      send({
        type: 'res', id: frame.id, ok: true,
        payload: {
          runId: frame.params.runId,
          status: 'completed',
          message: { text: 'Mock reply: 收到你的消息了。这是模拟 Gateway 的回复。', role: 'assistant' },
        },
      });
      return;
    }
    send({ type: 'res', id: frame.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: `unknown method ${frame.method}` } });
  }

  socket.on('close', () => {
    challengeSent = false;
    connected = false;
    console.log('[mock-gateway] client disconnected');
  });
  socket.on('error', (err) => {
    console.log('[mock-gateway] socket error:', err.message);
  });

  sendChallenge();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-gateway] listening ws://127.0.0.1:${PORT} (requirePairing=${REQUIRE_PAIRING})`);
});

// tick keepalive every 15s
setInterval(() => {
  console.log('[mock-gateway] tick');
}, 15000);
