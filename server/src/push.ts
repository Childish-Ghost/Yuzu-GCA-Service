/**
 * Push notifications — 审批通道（2026-08-14 升级）：
 *   - 微信通道移除（审批不再发微信；OpenClaw 微信会话保留）
 *   - 飞书改直连交互卡片（interactive card，含授权/拒绝按钮 + 回调）
 * 凭据：appId 从 openclaw.json 读，appSecret 从 ~/.openclaw/credentials/lark.secrets.json 读。
 * 保留异步 + 超时 + fire-and-forget 语义（CLI 冷启动慢的教训，见 docs/gap-v2.md）。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { serverConfig } from './config.js';

export interface PushTarget {
  channel: string;
  target: string;
}

/** owner 通道目标（App 卡片回调用同一 allowlist 校验 senderId） */
export const OWNER_FEISHU_OPEN_ID = 'ou_9e2a60ba69101ee35caaccfcb9f14cd1';

const TARGETS: PushTarget[] = [
  { channel: 'feishu', target: OWNER_FEISHU_OPEN_ID },
];

const LARK_API = 'https://open.feishu.cn/open-apis';
const LARK_TIMEOUT_MS = 15000;

/** 从 openclaw.json / credentials 读飞书凭据 */
export function loadLarkCreds(): { appId: string; appSecret: string } | null {
  try {
    const cfgPath = serverConfig.openclawConfig;
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const appId = raw?.channels?.feishu?.appId;
    if (!appId) return null;
    const secretFile = path.join(homedir(), '.openclaw', 'credentials', 'lark.secrets.json');
    const secrets = JSON.parse(readFileSync(secretFile, 'utf8'));
    const appSecret = secrets?.lark?.appSecret;
    if (!appSecret) return null;
    return { appId, appSecret };
  } catch {
    return null;
  }
}

/** 缓存 tenant_access_token（飞书有效期 2h，缓存 90 分钟） */
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getTenantAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const creds = loadLarkCreds();
  if (!creds) {
    console.error(new Date().toISOString(), '[push] lark creds not found (openclaw.json channels.feishu.appId + credentials/lark.secrets.json)');
    return null;
  }
  // 审查 H1：网络失败/超时必须吞掉——unhandledRejection 会炸整个进程
  try {
    const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
      signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
    });
    const body = await res.json() as any;
    if (body.code !== 0 || !body.tenant_access_token) {
      console.error(new Date().toISOString(), '[push] tenant token failed:', body.code, body.msg);
      return null;
    }
    cachedToken = { token: body.tenant_access_token, expiresAt: Date.now() + 90 * 60 * 1000 };
    return body.tenant_access_token;
  } catch (e: any) {
    console.error(new Date().toISOString(), '[push] tenant token request failed:', String(e?.message || e).slice(0, 200));
    return null;
  }
}

/** 发飞书交互卡片消息（receive_id_type=open_id） */
export async function sendFeishuCard(card: unknown, target = OWNER_FEISHU_OPEN_ID): Promise<{ ok: boolean; detail: string; messageId?: string }> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, detail: 'tenant token unavailable' };
  try {
    const res = await fetch(`${LARK_API}/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ receive_id: target, msg_type: 'interactive', content: JSON.stringify(card) }),
      signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
    });
    const body = await res.json() as any;
    if (body.code !== 0) return { ok: false, detail: `lark ${body.code}: ${body.msg}` };
    return { ok: true, detail: 'sent', messageId: body.data?.message_id };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 400) };
  }
}

/** 更新已发送卡片（审批后回写状态；卡片需 config.update_multi）。
 * 与 lark 插件 updateCardFeishu 完全一致：PATCH 只传 content（不带 msg_type——
 * 带 msg_type 会被飞书当作新消息处理，无法原地更新原卡片）。 */
export async function updateFeishuCard(messageId: string, card: unknown): Promise<{ ok: boolean; detail: string }> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, detail: 'tenant token unavailable' };
  try {
    const res = await fetch(`${LARK_API}/im/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content: JSON.stringify(card) }),
      signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
    });
    const body = await res.json() as any;
    if (body.code !== 0) return { ok: false, detail: `lark ${body.code}: ${body.msg}` };
    return { ok: true, detail: 'updated' };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 400) };
  }
}

/** 兼容旧调用：纯文本推送（保留——push_message 等非审批场景仍用文本） */
function sendOne(channel: string, target: string, text: string): Promise<{ channel: string; ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      serverConfig.openclawBin,
      ['message', 'send', '--channel', channel, '--target', target, '-m', text],
      { timeout: 90000 },
      (err, _stdout, stderr) => {
        resolve({ channel, ok: !err, detail: err ? String(stderr || err.message).slice(0, 400) : 'sent' });
      },
    );
  });
}

export async function push(text: string): Promise<{ accepted: boolean; channels: string[] }> {
  const channels = TARGETS.map(t => t.channel);
  // 审批场景由 ops.ts 调 pushApprovalCard（卡片）；此处兼容文本推送（feishu 文本）
  Promise.all(TARGETS.map(t => sendOne(t.channel, t.target, text)))
    .then(r => console.log(new Date().toISOString(), 'push delivered', JSON.stringify(r)))
    .catch(() => {});
  return { accepted: true, channels };
}
