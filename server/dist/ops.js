/**
 * High-risk operation authorization — confirmation codes + approval broker.
 *
 * Flow:
 *   1. Device POST /register { deviceName, machineId, deviceToken }
 *   2. Server generates 6-digit code, pushes to feishu/wechat
 *   3. Owner replies with the code
 *   4. Server POST /ops/approve { code } → approved → register device
 *   5. Device polls GET /ops/:id → "approved" → done
 *
 * 2026-08-12 审查修复（M6/S1/S6）：
 *   - GET /ops/:id 不再返回 code（getOpStatusPublic）——确认码只走 owner 通道
 *   - PendingOp 携带 deviceToken（设备自铸），审批落地时写注册表，不写 owner token
 *   - 错 5 次烧毁确认码（防 90 万组合暴力）
 *   - 待注册设备 token 登记表（pendingDevices）：设备在审批通过前不在注册表里，
 *     用它认证 GET /ops/:id 轮询
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { sendFeishuCard, updateFeishuCard, OWNER_FEISHU_OPEN_ID } from './push.js';
import { pushEntry } from './audit.js';
import { tokenEqual } from './consttime.js';
import { serverConfig } from './config.js';
import { emitOpEvent } from './ops_events.js';
const CODE_TTL_MS = 5 * 60 * 1000;
/** 单码最多错误尝试次数——超过即烧毁（配合限速防暴力） */
const MAX_CODE_ATTEMPTS = 5;
/** 待注册设备登记 TTL（op TTL 5min + 轮询余量） */
const PENDING_DEVICE_TTL_MS = 15 * 60 * 1000;
const ops = new Map();
/** 错码计数（code → {count, ts}）；count >= MAX_CODE_ATTEMPTS 时该码烧毁 */
const failedCodes = new Map();
/** 待注册设备 token 登记表（name → {token, expiresAt}） */
const pendingDevices = new Map();
function maskCode(code) {
    return `code:****${code.slice(-2)}`;
}
/** op → 公开事件形态（SSE/列表用，不含 code） */
function toPublicOp(op) {
    return {
        id: op.id,
        device: op.device,
        operation: op.operation,
        status: op.status,
        detail: op.detail,
        createdAt: op.createdAt,
        deviceIp: op.deviceIp,
    };
}
/** 卡片按钮签名：HMAC-SHA256(opId, GCA_SERVER_TOKEN) 前 16 hex——防伪造（扩展只透传） */
function cardSignature(opId) {
    return createHmac('sha256', serverConfig.token || 'gca-no-token')
        .update(opId).digest('hex').slice(0, 16);
}
/** 校验卡片回调签名 + senderId 是 owner */
export function verifyCardAction(opId, signature, senderId) {
    if (senderId !== OWNER_FEISHU_OPEN_ID)
        return false;
    return tokenEqual(signature, cardSignature(opId));
}
/** 构造审批交互卡片（schema 2.0）并推送飞书（2026-08-14：文本确认码 → 授权框卡片） */
async function pushApprovalCard(op) {
    const opLabel = op.operation === 'device_registration' ? '设备接入' : op.operation;
    const detailLines = [
        op.operation === 'device_registration' ? `设备 ${op.device}${op.deviceIp ? `（IP ${op.deviceIp}）` : ''} 请求接入` : `设备 ${op.device} 请求操作：${op.operation}`,
        ...(op.detail ? [`详情：${op.detail}`] : []),
        `失效时间：${new Date(op.createdAt + 5 * 60 * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    ];
    const sig = cardSignature(op.id);
    // schema 2.0：按钮直接作为 element（不支持 note/action 容器标签）
    const card = {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '请授权以继续当前操作' }, template: 'blue' },
        body: {
            elements: [
                { tag: 'markdown', content: detailLines.join('\n') },
                { tag: 'markdown', content: '授权后，应用将能够以你的身份执行相关操作。' },
                // value 必须带 action 字段（lark 插件 extractBasics 读 value.action）；
                // 格式 gca:verb:opId:sig（namespace 用单冒号分隔——OpenClaw dispatch 按首个 ':' 切 namespace/payload）
                { tag: 'button', text: { tag: 'plain_text', content: '前往授权' }, type: 'primary', value: { action: `gca:approve:${op.id}:${sig}` } },
                { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'default', value: { action: `gca:reject:${op.id}:${sig}` } },
            ],
        },
    };
    const r = await sendFeishuCard(card);
    console.log(new Date().toISOString(), `[push] approval card ${op.id} -> ${r.ok ? 'sent' : `FAIL ${r.detail}`}`);
    if (r.ok && r.messageId)
        op.cardMessageId = r.messageId;
}
/** 审批后回写卡片状态 */
export async function updateApprovalCard(op, status) {
    if (!op.cardMessageId)
        return;
    const statusText = status === 'approved' ? '✅ 已授权' : status === 'rejected' ? '⛔ 已拒绝' : '⏳ 已过期';
    const card = {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: statusText }, template: status === 'approved' ? 'green' : 'red' },
        body: {
            elements: [
                { tag: 'markdown', content: `设备 ${op.device} 的${op.operation === 'device_registration' ? '接入' : '操作'}请求已${status === 'approved' ? '授权' : status === 'rejected' ? '拒绝' : '过期'}。` },
            ],
        },
    };
    const r = await updateFeishuCard(op.cardMessageId, card);
    console.log(new Date().toISOString(), `[push] card update ${op.id} -> ${r.ok ? 'ok' : `FAIL ${r.detail}`}`);
}
export function createOpRequest(device, operation, detail, deviceIp, machineId, devicePort, deviceToken) {
    // 审查 L2：opId 随机熵提升（原 randomInt 仅 ~13bit；时间戳+8B 随机）
    const id = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
    const code = String(randomInt(100000, 999999));
    ops.set(id, {
        id, device, operation,
        detail: detail.slice(0, 200),
        code, status: 'pending',
        createdAt: Date.now(),
        deviceIp, machineId, devicePort,
        ...(deviceToken ? { deviceToken } : {}),
    });
    // 2026-08-14：飞书改发交互授权卡片（按钮审批）；纯文本确认码保留（AI/面板通道）
    // 审查 H1：卡片发送失败绝不向上抛（fire-and-forget 必须 catch——否则 unhandledRejection 炸进程）
    pushApprovalCard(ops.get(id)).catch(() => { });
    pushEntry({
        ts: Date.now(), deviceId: device,
        action: `ops_request:${operation}`,
        detail: maskCode(code), status: 'pending',
    });
    emitOpEvent(toPublicOp(ops.get(id)));
    return { id, code, expiresInSec: 300 };
}
export function approveOp(code) {
    for (const [, op] of ops) {
        if (Date.now() - op.createdAt > CODE_TTL_MS && op.status === 'pending') {
            op.status = 'expired';
            emitOpEvent(toPublicOp(op)); // 审查 M6：过期标记补事件（App/卡片及时收到 resolved）
        }
    }
    // 烧码：同一 code 错试次数已达上限 → 拒绝（需 owner 重新发起）
    const fail = failedCodes.get(code);
    if (fail && fail.count >= MAX_CODE_ATTEMPTS) {
        return { ok: false, error: 'code burned: too many failed attempts' };
    }
    const entry = [...ops.values()].find(o => o.code === code && o.status === 'pending');
    if (!entry) {
        // 只对 6 位码计数（防 Map 被任意串刷爆）
        if (/^\d{6}$/.test(code)) {
            failedCodes.set(code, { count: (fail?.count ?? 0) + 1, ts: Date.now() });
        }
        return { ok: false, error: 'invalid or expired code' };
    }
    failedCodes.delete(code);
    entry.status = 'approved';
    pushEntry({
        ts: Date.now(), deviceId: entry.device,
        action: `ops_approved:${entry.operation}`,
        detail: '', status: 'approved',
    });
    emitOpEvent(toPublicOp(entry));
    return { ok: true, op: entry };
}
export function rejectOp(code) {
    const entry = [...ops.values()].find(o => o.code === code && o.status === 'pending');
    if (!entry)
        return false;
    entry.status = 'rejected';
    // 审查 M3：拒绝补审计（三通道一致）
    pushEntry({ ts: Date.now(), deviceId: entry.device, action: `ops_rejected:${entry.operation}`, detail: '', status: 'rejected' });
    emitOpEvent(toPublicOp(entry));
    return true;
}
/** 按确认码查找 op（卡片回写用——rejectOp 返回 boolean 后按 code 定位） */
export function getOpByCode(code) {
    return [...ops.values()].find(o => o.code === code);
}
/** 按 id 审批（App/卡片回调通道，2026-08-14）——device_registration 副作用由调用方处理 */
export function approveOpById(id) {
    const op = ops.get(id);
    if (!op)
        return { ok: false, error: 'op not found' };
    // 审查 M2：先查终态（对已终态 op 报 already，而非 expired——语义正确）
    if (op.status !== 'pending')
        return { ok: false, error: `op already ${op.status}` };
    if (Date.now() - op.createdAt > CODE_TTL_MS) {
        op.status = 'expired';
        emitOpEvent(toPublicOp(op));
        return { ok: false, error: 'op expired' };
    }
    op.status = 'approved';
    pushEntry({
        ts: Date.now(), deviceId: op.device,
        action: `ops_approved:${op.operation}`,
        detail: '', status: 'approved',
    });
    emitOpEvent(toPublicOp(op));
    return { ok: true, op };
}
export function rejectOpById(id) {
    const op = ops.get(id);
    if (!op)
        return { ok: false, error: 'op not found' };
    if (op.status !== 'pending')
        return { ok: false, error: `op already ${op.status}` };
    if (Date.now() - op.createdAt > CODE_TTL_MS) {
        op.status = 'expired';
        emitOpEvent(toPublicOp(op));
        return { ok: false, error: 'op expired' };
    }
    op.status = 'rejected';
    // 审查 M3：拒绝补审计（与 rejectOp 一致）
    pushEntry({ ts: Date.now(), deviceId: op.device, action: `ops_rejected:${op.operation}`, detail: '', status: 'rejected' });
    emitOpEvent(toPublicOp(op));
    return { ok: true, op };
}
/** 待审批列表（App 轮询/SSE snapshot/面板，不含 code） */
export function listOps(status) {
    const out = [];
    for (const op of ops.values()) {
        if (status && op.status !== status)
            continue;
        out.push(toPublicOp(op));
    }
    // 新→旧
    return out.sort((a, b) => b.createdAt - a.createdAt);
}
export function getOpStatus(id) {
    return ops.get(id);
}
/** 公开状态（轮询用）——不含 code（M6 修复：确认码只走 owner 通道） */
export function getOpStatusPublic(id) {
    const op = ops.get(id);
    if (!op)
        return undefined;
    return {
        id: op.id,
        device: op.device,
        operation: op.operation,
        status: op.status,
        detail: op.detail,
        createdAt: op.createdAt,
    };
}
// --- 待注册设备 token 登记（S1：/register 携带 deviceToken，审批前用于轮询认证） ---
export function registerPendingDevice(name, token) {
    pendingDevices.set(name, { token, expiresAt: Date.now() + PENDING_DEVICE_TTL_MS });
}
export function pendingDeviceNameByToken(token) {
    const now = Date.now();
    for (const [name, p] of pendingDevices) {
        if (p.expiresAt > now && tokenEqual(p.token, token))
            return name;
    }
    return null;
}
export function clearPendingDevice(name) {
    pendingDevices.delete(name);
}
export function sweepOps() {
    let cleaned = 0;
    const now = Date.now();
    // 真正删除：过期 pending 标 expired（审查 M6：保留 1 小时再删——与终态一致，
    // 设备轮询能区分"已过期"而非 404；App 列表也能看到 expired 项）
    for (const [id, op] of ops) {
        if (op.status === 'pending' && now - op.createdAt > CODE_TTL_MS) {
            op.status = 'expired';
            emitOpEvent(toPublicOp(op)); // App/卡片收到过期事件
            cleaned++;
        }
        else if (op.status !== 'pending' && now - op.createdAt > 60 * 60 * 1000) {
            ops.delete(id);
            cleaned++;
        }
    }
    // 错码计数：1 小时后无论是否烧毁一律清除（防 Map 无限增长——烧毁码在
    // op 的 5 分钟 TTL 过后本来就失去意义）
    if (failedCodes.size > 0) {
        for (const [code, f] of failedCodes) {
            if (now - f.ts > 60 * 60 * 1000)
                failedCodes.delete(code);
        }
    }
    // 待注册设备登记过期清扫
    for (const [name, p] of pendingDevices) {
        if (p.expiresAt <= now) {
            pendingDevices.delete(name);
            cleaned++;
        }
    }
    return cleaned;
}
// S14 家族：sweep 定时器不阻塞进程退出（否则测试/close 后进程挂起）
const sweepTimer = setInterval(sweepOps, 60000);
sweepTimer.unref();
//# sourceMappingURL=ops.js.map