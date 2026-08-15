/**
 * verify-approval.mjs — 审批新端点验证（2026-08-14）：
 *   1. GET /ops?status=pending 列表
 *   2. POST /ops/:id/approve + reject（按 id 审批）
 *   3. GET /ops/events SSE（snapshot + op.created/op.resolved）
 *   4. POST /ops/card-action 签名校验（错签 403 / 对签批准）
 * 用法：node scripts/verify-approval.mjs（自起隔离实例）
 */
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OWNER_TOKEN = 'verify-owner-' + randomBytes(16).toString('hex');
const PORT = 18796;
const dir = mkdtempSync(path.join(tmpdir(), 'gca-approval-'));
const openclawPath = path.join(dir, 'openclaw.json');
writeFileSync(openclawPath, JSON.stringify({ mcp: { servers: {} } }, null, 2));

process.env.GCA_SERVER_TOKEN = OWNER_TOKEN;
process.env.GCA_SERVER_PORT = String(PORT);
process.env.OPENCLAW_CONFIG = openclawPath;

const { startServer } = await import('../server/dist/gca-server.js');
const { createOpRequest, listOps, verifyCardAction, approveOpById } = await import('../server/dist/ops.js');

const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// 起 server（实际端口由 env 决定——startServer 用 serverConfig.port）
const srv = startServer();
await new Promise(r => setTimeout(r, 300));

try {
  // 1. 创建两个 op（直接调 ops.ts——/ops/request 走设备通道需设备认证，直接构造更稳）
  const op1 = createOpRequest('verify-device-a', 'device_registration', 'verify op A', '10.0.0.5', 'mid-a', 3001, 'dev-token-a-0123456789abcdef0123456789abcdef');
  const op2 = createOpRequest('verify-device-b', 'exec', 'verify op B', '10.0.0.6');

  // 2. 列表（owner）
  let r = await fetch(`${BASE}/ops?status=pending`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  let body = await r.json();
  check('GET /ops?status=pending 200 + 2 项', r.status === 200 && body.ops?.length === 2, `count=${body.ops?.length}`);
  check('列表不含 code', body.ops?.every(o => o.code === undefined));

  // 3. 未授权 401
  r = await fetch(`${BASE}/ops?status=pending`);
  check('无 token 列表 401', r.status === 401);

  // 4. 按 id 批准（device_registration）
  r = await fetch(`${BASE}/ops/${op1.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  body = await r.json();
  check('POST /ops/:id/approve 200', r.status === 200 && body.ok, JSON.stringify(body));

  // 5. 批准后列表剩 1
  r = await fetch(`${BASE}/ops?status=pending`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  body = await r.json();
  check('批准后 pending 剩 1', body.ops?.length === 1, `count=${body.ops?.length} ops=${JSON.stringify(body.ops?.map(o => o.id + ':' + o.status))}`);

  // 6. 按 id 拒绝
  r = await fetch(`${BASE}/ops/${op2.id}/reject`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  check('POST /ops/:id/reject 200', r.status === 200);

  // 7. 重复批准 → 403
  r = await fetch(`${BASE}/ops/${op2.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  check('重复批准 403（非 pending）', r.status === 403);

  // 8. 卡片签名
  const goodSig = createHmac('sha256', OWNER_TOKEN).update(op1.id).digest('hex').slice(0, 16);
  check('verifyCardAction 真签 true', verifyCardAction(op1.id, goodSig, 'ou_9e2a60ba69101ee35caaccfcb9f14cd1') === true);
  check('verifyCardAction 错签 false', verifyCardAction(op1.id, 'deadbeef', 'ou_9e2a60ba69101ee35caaccfcb9f14cd1') === false);
  check('verifyCardAction 非 owner sender false', verifyCardAction(op1.id, goodSig, 'ou_other') === false);

  // 9. card-action 端点（用已批准 op 会 403——重新建一个）
  const op3 = createOpRequest('verify-device-c', 'device_registration', 'card op C', '10.0.0.7', 'mid-c', 3001, 'dev-token-c');
  const sig3 = createHmac('sha256', OWNER_TOKEN).update(op3.id).digest('hex').slice(0, 16);
  r = await fetch(`${BASE}/ops/card-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opId: op3.id, action: 'approve', signature: sig3, senderId: 'ou_9e2a60ba69101ee35caaccfcb9f14cd1' }),
  });
  body = await r.json();
  check('card-action 批准 200', r.status === 200 && body.status === 'approved', JSON.stringify(body));

  r = await fetch(`${BASE}/ops/card-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opId: op3.id, action: 'approve', signature: 'badsig', senderId: 'ou_9e2a60ba69101ee35caaccfcb9f14cd1' }),
  });
  check('card-action 错签 403', r.status === 403);

  // 10. SSE：连 /ops/events，创建 op，收 snapshot + created 事件
  const events = [];
  const ac = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/ops/events`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice(7));
          if (events.length >= 3) { ac.abort(); return; }
        }
      }
    }
  })();
  // snapshot 测试：先建一个 pending op 再连 SSE（否则 snapshot 为空不发事件）
  const sseOp = createOpRequest('verify-device-e', 'exec', 'sse pending op', '10.0.0.9');
  await new Promise(r2 => setTimeout(r2, 200));
  createOpRequest('verify-device-d', 'device_registration', 'sse op D', '10.0.0.8');
  await Promise.race([ssePromise.catch(() => {}), new Promise(r2 => setTimeout(r2, 3000))]);
  check('SSE 收到 snapshot', events.includes('op.snapshot'));
  check('SSE 收到 created', events.includes('op.created'));
  check('SSE 收到 ready', events.includes('ready'));
  console.log('  events:', events.join(', '));
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
