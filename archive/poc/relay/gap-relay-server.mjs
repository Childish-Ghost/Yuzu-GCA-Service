/**
 * GAP Relay - approval push + clipboard sync + device pairing (INT-001).
 *
 * Endpoints:
 *   GET  /health                          — liveness
 *   POST /push          Bearer <token>    — approval push (async, 202)
 *   GET  /clipboard/latest                — get latest synced clipboard
 *   POST /clipboard/push Bearer <token>    — push local clipboard
 *   POST /pair/init     Bearer <token>    — generate one-time pairing code
 *   POST /pair/claim                       — claim code, auto-register in openclaw.json
 *
 * Token lives in ~/<服务端token路径> (same pairing token as the devices).
 * Pairing codes are one-time, 10-minute TTL.
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.GAP_RELAY_PORT) || 18790;
const TOKEN = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'token.txt'), 'utf8').trim();
const OPENCLAW_CONFIG = path.join(process.env.HOME || process.env.USERPROFILE || '/home/gca', '.openclaw', 'openclaw.json');

const TARGETS = [
  { channel: 'feishu', target: 'ou_9e2a60ba69101ee35caaccfcb9f14cd1' },
  { channel: 'openclaw-weixin', target: 'o9cq802h_JTovYHG16ua-yf-9TH4@im.wechat' },
];

// --- Device-to-device clipboard sync store (text + images, 5MB cap) ---
let clipboard = { content: '', type: 'text', deviceId: '', updatedAt: 0 };
const MAX_CLIPBOARD_BYTES = 5 * 1024 * 1024;

// --- INT-003: Audit log (in-memory ring buffer, 1000 entries) ---
const auditLog = [];
const AUDIT_MAX = 1000;

// --- INT-003: Device management helpers ---
async function listDevices() {
  const config = JSON.parse(await readFile(OPENCLAW_CONFIG, 'utf8'));
  const servers = config.mcp?.servers ?? {};
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    url: cfg.url,
    transport: cfg.transport,
    hasAuth: !!(cfg.headers?.Authorization),
  }));
}

async function revokeDevice(deviceName) {
  const config = JSON.parse(await readFile(OPENCLAW_CONFIG, 'utf8'));
  if (!config.mcp?.servers?.[deviceName]) return false;
  delete config.mcp.servers[deviceName];
  await writeFile(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
  reloadGateway();
  return true;
}

// --- Pairing codes: one-time, 10-minute TTL ---
const pairingCodes = new Map(); // code → { expiresAt, claimed }
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function mintPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

async function registerDevice(deviceName, deviceIp, port, pairingToken) {
  const config = JSON.parse(await readFile(OPENCLAW_CONFIG, 'utf8'));
  config.mcp = config.mcp || { servers: {} };
  config.mcp.servers[deviceName] = {
    url: `http://${deviceIp}:${port}/mcp`,
    transport: 'streamable-http',
    headers: { Authorization: `Bearer ${pairingToken}` },
  };
  await writeFile(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function reloadGateway() {
  const openclawBin = '/home/gca/.nvm/versions/node/v22.23.1/bin/openclaw';
  execFile(openclawBin, ['mcp', 'reload'], { timeout: 15000 }, () => {});
}

function sendOne(channel, target, text) {
  return new Promise((resolve) => {
    execFile(
      '/home/gca/.nvm/versions/node/v22.23.1/bin/openclaw',
      ['message', 'send', '--channel', channel, '--target', target, '-m', text],
      { timeout: 90000 },
      (err, stdout, stderr) => {
        resolve({ channel, ok: !err, detail: err ? String(stderr || err.message).slice(0, 400) : 'sent' });
      },
    );
  });
}

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || presented.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(TOKEN));
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > maxBytes) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  // --- Health ---
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'gap-relay' }));
    return;
  }

  // --- Approval push ---
  if (req.method === 'POST' && req.url === '/push') {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const body = JSON.parse(await readBody(req) || '{}');
    const text = String(body.text ?? '').slice(0, 500);
    if (!text) { res.writeHead(400); res.end('{"error":"missing text"}'); return; }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, channels: TARGETS.map(t => t.channel) }));
    Promise.all(TARGETS.map(t => sendOne(t.channel, t.target, text)))
      .then(r => console.log(new Date().toISOString(), 'push delivered', JSON.stringify(r)))
      .catch(() => {});
    return;
  }

  // --- Clipboard sync ---
  if (req.method === 'POST' && req.url === '/clipboard/push') {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const body = JSON.parse(await readBody(req) || '{}');
    const content = String(body.content ?? '').slice(0, MAX_CLIPBOARD_BYTES);
    clipboard = { content, type: body.type === 'image' ? 'image' : 'text', deviceId: String(body.deviceId ?? ''), updatedAt: Date.now() };
    console.log(new Date().toISOString(), 'clipboard pushed', { deviceId: clipboard.deviceId, type: clipboard.type, bytes: content.length });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && req.url === '/clipboard/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clipboard));
    return;
  }

  // --- INT-001: Pairing handshake ---
  // Owner generates a one-time pairing code (requires existing Bearer token)
  if (req.method === 'POST' && req.url === '/pair/init') {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    // Clean expired codes
    for (const [code, entry] of pairingCodes) {
      if (Date.now() > entry.expiresAt) pairingCodes.delete(code);
    }
    const code = mintPairingCode();
    while (pairingCodes.has(code)) { code = mintPairingCode(); } // unlikely but safe
    pairingCodes.set(code, { expiresAt: Date.now() + 10 * 60 * 1000, claimed: false });
    console.log(new Date().toISOString(), 'pairing code generated:', code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, expiresInSec: 600 }));
    return;
  }

  // New device claims the code and auto-registers
  if (req.method === 'POST' && req.url === '/pair/claim') {
    const body = JSON.parse(await readBody(req) || '{}');
    const { code, deviceName, port } = body;
    const entry = pairingCodes.get(code);
    if (!entry || Date.now() > entry.expiresAt || entry.claimed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid, expired, or already claimed code' }));
      return;
    }
    entry.claimed = true;
    pairingCodes.delete(code);

    const devicePort = Number(port) || 3001;
    const deviceIp = req.socket.remoteAddress?.replace('::ffff:', '') || '127.0.0.1';

    try {
      await registerDevice(deviceName || `device-${Date.now().toString(36)}`, deviceIp, devicePort, TOKEN);
      reloadGateway();
      console.log(new Date().toISOString(), 'device registered:', deviceName, 'at', `${deviceIp}:${devicePort}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pairingToken: TOKEN, deviceIp, devicePort, message: 'Registered in gateway. Run `openclaw mcp reload` on the server if auto-reload hasn\'t picked it up.' }));
    } catch (err) {
      console.error(new Date().toISOString(), 'pair registration failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'registration failed', detail: err.message }));
    }
    return;
  }

  // --- INT-003: Device management ---
  // List all registered devices
  if (req.method === 'GET' && req.url === '/devices') {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    try {
      const devices = await listDevices();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices, count: devices.length }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Revoke a device (remove from openclaw.json + reload)
  const revokeMatch = req.url.match(/^\/devices\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && revokeMatch) {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const deviceName = revokeMatch[1];
    try {
      const removed = await revokeDevice(deviceName);
      if (removed) {
        auditLog.push({ ts: Date.now(), action: 'device_revoked', deviceName });
        if (auditLog.length > AUDIT_MAX) auditLog.shift();
        console.log(new Date().toISOString(), 'device revoked:', deviceName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, revoked: deviceName }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'device not found' }));
      }
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- INT-003: Audit log ---
  // Receive audit entry from a device
  if (req.method === 'POST' && req.url === '/audit') {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const body = JSON.parse(await readBody(req, 16384) || '{}');
    const entry = {
      ts: body.ts || Date.now(),
      deviceId: body.deviceId || 'unknown',
      action: String(body.action || '').slice(0, 200),
      detail: String(body.detail || '').slice(0, 500),
      status: String(body.status || '').slice(0, 50),
    };
    auditLog.push(entry);
    if (auditLog.length > AUDIT_MAX) auditLog.shift();
    console.log(new Date().toISOString(), 'audit:', entry.deviceId, entry.action, entry.status);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Query audit log (optional ?limit=N&device=X)
  if (req.method === 'GET' && req.url.startsWith('/audit')) {
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, AUDIT_MAX);
    const device = url.searchParams.get('device');
    let entries = auditLog;
    if (device) entries = entries.filter(e => e.deviceId === device);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries: entries.slice(-limit), count: entries.length }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gap-relay listening on 0.0.0.0:${PORT} (pairing + push + clipboard + devices + audit)`);
});
