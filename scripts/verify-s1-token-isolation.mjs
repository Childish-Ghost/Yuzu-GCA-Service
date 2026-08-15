/**
 * verify-s1-token-isolation.mjs — S1 设备 token 隔离集成验证（2026-08-12 审查）。
 *
 * 起一个隔离的 gca-server 测试实例（随机端口 + 临时 openclaw.json），验证：
 *   1. /pair/claim 不再返回 pairingToken（owner token 不再发给设备）
 *   2. openclaw.json 写入的是设备自铸 token，不是 owner token
 *   3. /heartbeat：设备 token 200 / owner token 401
 *   4. /register：owner 通道响应含确认码；设备通道不含（M6）
 *   5. GET /ops/:id 响应不含 code（M6）
 *   6. /clipboard/latest：无鉴权 401 / 设备 token 200（S2）
 *
 * 用法：node scripts/verify-s1-token-isolation.mjs
 * 退出码 0 = 全部通过。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OWNER_TOKEN = 'owner-token-' + randomBytes(16).toString('hex'); // 任意长度 ≥ 普通 token
const DEVICE_TOKEN = randomBytes(32).toString('hex'); // 64 hex —— 设备自铸
const MACHINE_ID = 'verify-mid-0001';
const PORT = 18795;
const dir = mkdtempSync(path.join(tmpdir(), 'gca-s1-'));
const openclawPath = path.join(dir, 'openclaw.json');
writeFileSync(openclawPath, JSON.stringify({ mcp: { servers: {} } }, null, 2));

process.env.GCA_SERVER_TOKEN = OWNER_TOKEN;
process.env.GCA_SERVER_PORT = String(PORT);
process.env.OPENCLAW_CONFIG = openclawPath;
process.env.OPENCLAW_BIN = 'node'; // 免探测，reload 调用静默失败即可

const { startServer } = await import('../server/dist/gca-server.js');
const server = startServer();
await new Promise((r) => server.once('listening', r));

const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
}

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // 1. 配对：owner 铸码 → 设备 claim（携自铸 deviceToken + machineId）
  const init = await req('POST', '/pair/init', { token: OWNER_TOKEN });
  check('pair/init 生成配对码', init.status === 200 && !!init.data.code, `status=${init.status}`);

  const claim = await req('POST', '/pair/claim', {
    body: { code: init.data.code, deviceName: 'verify-device', port: 3001, deviceToken: DEVICE_TOKEN, machineId: MACHINE_ID },
  });
  check('pair/claim 成功', claim.status === 200, `status=${claim.status} ${claim.data.error ?? ''}`);
  check('pair/claim 响应不含 pairingToken（S1）', !('pairingToken' in claim.data));

  // 2. 注册表：写入的是设备 token
  const cfg = JSON.parse(readFileSync(openclawPath, 'utf8'));
  const entry = cfg.mcp.servers['verify-device'];
  check('openclaw.json 注册成功', !!entry);
  if (entry) {
    const auth = entry.headers?.Authorization ?? '';
    check('Authorization = 设备 token（非 owner token）', auth === `Bearer ${DEVICE_TOKEN}`);
    check('设备 token 字段存在', entry.deviceToken === DEVICE_TOKEN);
    check('machineId 已写入（S10）', entry.machineId === MACHINE_ID);
  }

  // 3. 心跳：设备 token 通过 / owner token 拒绝
  const hbDev = await req('POST', '/heartbeat', { token: DEVICE_TOKEN, body: { machineId: MACHINE_ID, port: 3001 } });
  check('heartbeat 设备 token → 200', hbDev.status === 200, `status=${hbDev.status}`);
  const hbOwner = await req('POST', '/heartbeat', { token: OWNER_TOKEN, body: { machineId: MACHINE_ID, port: 3001 } });
  check('heartbeat owner token → 401（隔离生效）', hbOwner.status === 401, `status=${hbOwner.status}`);

  // 4. /register 双通道：owner 带码 / 设备不带码（设备通道：全新自铸 token 即受理，
  //    信任闸门是 owner 审批）
  const regOwner = await req('POST', '/register', { token: OWNER_TOKEN, body: { deviceName: 'reg-owner-dev', port: 3001 } });
  check('register(owner) 响应含确认码', regOwner.status === 200 && !!regOwner.data.code);
  const DEVICE_TOKEN2 = randomBytes(32).toString('hex'); // 全新设备自铸 token（服务端未知）
  const regDev = await req('POST', '/register', {
    token: DEVICE_TOKEN2,
    body: { deviceName: 'verify-device2', machineId: MACHINE_ID + 'b', port: 3001, deviceToken: DEVICE_TOKEN2 },
  });
  check('register(device) 成功（全新 token 即受理）', regDev.status === 200, `status=${regDev.status}`);
  check('register(device) 响应不含确认码（M6）', !('code' in regDev.data));
  // 已注册设备再注册 → approved 且设备通道无 code 字段
  const regAgain = await req('POST', '/register', {
    token: DEVICE_TOKEN,
    body: { deviceName: 'verify-device', machineId: MACHINE_ID, port: 3001, deviceToken: DEVICE_TOKEN },
  });
  check('已注册设备再注册 → approved', regAgain.data.status === 'approved');
  check('已注册响应设备通道无 code 字段', !('code' in regAgain.data));

  // 5. GET /ops/:id（设备轮询）→ 不含 code
  const opId = regDev.data.id;
  const opStatus = await req('GET', `/ops/${opId}`, { token: DEVICE_TOKEN2 });
  check('GET /ops/:id 设备 token → 200', opStatus.status === 200);
  check('GET /ops/:id 响应不含 code（M6）', !('code' in opStatus.data));
  check('GET /ops/:id 含 status', !!opStatus.data.status);

  // 6. 剪贴板鉴权（S2）
  const clipNoAuth = await req('GET', '/clipboard/latest');
  check('clipboard/latest 无鉴权 → 401（S2）', clipNoAuth.status === 401, `status=${clipNoAuth.status}`);
  const clipDev = await req('GET', '/clipboard/latest', { token: DEVICE_TOKEN });
  check('clipboard/latest 设备 token → 200', clipDev.status === 200, `status=${clipDev.status}`);
  const clipPush = await req('POST', '/clipboard/push', { token: DEVICE_TOKEN, body: { content: 's1-verify', type: 'text' } });
  check('clipboard/push 设备 token → 200', clipPush.status === 200, `status=${clipPush.status}`);
  const clipPull = await req('GET', '/clipboard/latest', { token: DEVICE_TOKEN });
  check('clipboard deviceId 被服务端覆盖为设备名', clipPull.data.deviceId === 'verify-device');

  // 7. 审计设备身份覆盖（S1）
  const audit = await req('POST', '/audit', { token: DEVICE_TOKEN, body: { deviceId: 'spoofed', action: 'exec', detail: 'x', status: 'ok' } });
  check('audit 设备 token → 200', audit.status === 200);
  const auditGet = await req('GET', '/audit?limit=5', { token: OWNER_TOKEN });
  const last = auditGet.data.entries?.at(-1);
  check('audit deviceId 覆盖为设备名（防伪造）', last?.deviceId === 'verify-device', `got=${last?.deviceId}`);

  // 8. 设备端点越权检查：设备 token 调 owner 端点 → 401
  const ownerOnly = await req('POST', '/pair/init', { token: DEVICE_TOKEN });
  check('设备 token 调 /pair/init → 401（授权坍缩已修复）', ownerOnly.status === 401, `status=${ownerOnly.status}`);
  const devList = await req('GET', '/devices', { token: DEVICE_TOKEN });
  check('设备 token 调 /devices → 401', devList.status === 401, `status=${devList.status}`);
} finally {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n✅ S1 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
