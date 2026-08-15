/**
 * gca-server MCP endpoint — management tools for the AI agent.
 *
 * Streamable HTTP transport (MCP spec 2025-03-26), zero dependencies.
 * Tools (management only, separate from device client tools):
 *   approve_op     — approve/reject a confirmation code
 *   list_devices   — list registered devices
 *   register_device— request device registration
 *   revoke_device  — revoke a device
 *   query_audit    — query audit log
 *   push_message   — push a message to feishu/wechat
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { serverConfig } from './config.js';
import { tokenEqual } from './consttime.js';
import { listDevices, revokeDevice } from './devices.js';
import { approveOp, rejectOp, createOpRequest, registerPendingDevice, clearPendingDevice } from './ops.js';
import { query as queryAudit } from './audit.js';
import { push } from './push.js';

const TOKEN = serverConfig.token;

const PROTOCOL_VERSION = '2025-03-26';
const TOOLS = [
  {
    name: 'approve_op',
    description:
      'Approve or reject a pending GCA operation (device registration, power, service) using its 6-digit confirmation code. ' +
      'When the user replies with a 6-digit code from a GCA push notification, call this tool with that code. ' +
      'Returns the operation status and device.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '6-digit confirmation code' },
        action: { type: 'string', enum: ['approve', 'reject'], description: 'approve or reject (default approve)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'list_devices',
    description: 'List all registered devices with their URLs and machineIds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'register_device',
    description:
      'Request device registration. Generates a 6-digit confirmation code pushed to feishu/wechat. ' +
      'deviceToken 需由设备自己铸造并在设备侧发起注册（/pair/claim 或 /register）时携带；' +
      'AI 通道发起的注册若未携带 deviceToken，审批时将被拒绝——设备必须自证身份。',
    inputSchema: {
      type: 'object',
      properties: {
        deviceName: { type: 'string', description: 'device name' },
        machineId: { type: 'string', description: 'device unique machine id (SMBIOS UUID)' },
        port: { type: 'number', description: 'device MCP port (default 3001)' },
        deviceToken: { type: 'string', description: 'device-minted token (min 32 chars). 设备在审批通过后用它认证自身端点' },
        deviceIp: { type: 'string', description: '设备可达 IP（AI 通道无法从 socket 获取来源 IP——必须由 owner 提供；缺省时注册 URL 无效）' },
      },
      required: ['deviceName'],
    },
  },
  {
    name: 'revoke_device',
    description: 'Revoke (unregister) a device by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'device name' } },
      required: ['name'],
    },
  },
  {
    name: 'query_audit',
    description: 'Query the audit log. Optional limit and device filter.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'max entries (default 50)' },
        device: { type: 'string', description: 'filter by device name' },
      },
    },
  },
  {
    name: 'push_message',
    description: 'Push a text message to the owner via feishu and wechat.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'message text' } },
      required: ['text'],
    },
  },
  {
    name: 'chat_ai',
    description:
      'Send a message to the AI assistant and get its reply. ' +
      'Pass the same sessionKey to continue the same conversation (context is kept per session). ' +
      'The AI can call device MCP tools and gca-server management tools during the turn.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'the message to the AI' },
        sessionKey: { type: 'string', description: 'conversation session key (default "main" — shared with feishu/weixin)' },
      },
      required: ['message'],
    },
  },
];

interface McpRequest {
  jsonrpc: string;
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function jsonResponse(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleToolsCall(id: number | string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'approve_op': {
      const code = String(args.code ?? '').trim();
      if (!code) return { error: { code: -32602, message: 'code required' } };
      const action = String(args.action ?? 'approve');
      if (action === 'reject') {
        const ok = rejectOp(code);
        if (!ok) return { error: { code: -32602, message: 'invalid or expired code' } };
        return { result: { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', confirmedByUser: true }) }] } };
      }
      const result = approveOp(code);
      if (!result.ok || !result.op) return { error: { code: -32602, message: result.error || 'invalid or expired code' } };
      const op = result.op;
      // If this was a device registration, actually register the device。
      // S1：注册写设备自铸 token（不再写 owner token）；缺 deviceToken → 拒绝，
      // 引导设备自身发起注册（/pair/claim 或 /register）。
      if (op.operation === 'device_registration') {
        if (!op.deviceToken) {
          return { error: { code: -32603, message: 'registration requires deviceToken——设备需通过 /pair/claim 或 /register 携带自铸 token 注册' } };
        }
        try {
          const { registerDevice } = await import('./devices.js');
          await registerDevice(op.device, op.deviceIp || 'unknown', op.devicePort || 3001, op.deviceToken, op.machineId);
          clearPendingDevice(op.device);
        } catch (err) {
          return { error: { code: -32603, message: `registration failed: ${err instanceof Error ? err.message : String(err)}` } };
        }
      }
      return { result: { content: [{ type: 'text', text: JSON.stringify({ status: 'approved', operation: op.operation, device: op.device, confirmedByUser: true }) }] } };
    }
    case 'list_devices': {
      try {
        const devices = await listDevices();
        return { result: { content: [{ type: 'text', text: JSON.stringify({ devices, count: devices.length }) }] } };
      } catch (err) {
        return { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
      }
    }
    case 'register_device': {
      const deviceName = String(args.deviceName ?? '').trim();
      if (!deviceName) return { error: { code: -32602, message: 'deviceName required' } };
      const machineId = String(args.machineId ?? '');
      const port = Number(args.port) || 3001;
      const deviceToken = args.deviceToken ? String(args.deviceToken) : '';
      // F2 修复（RA6 追溯）：deviceIp 此前硬编码 'mcp'——注册 URL http://mcp:port/mcp 无效。
      // AI 通道无法从 socket 取来源 IP，必须由 owner 提供。
      const deviceIp = args.deviceIp ? String(args.deviceIp) : '';
      const result = createOpRequest(deviceName, 'device_registration', `新设备 ${deviceName} 请求注册`, deviceIp, machineId, port, deviceToken);
      if (deviceToken) registerPendingDevice(deviceName, deviceToken);
      // M6：响应不含确认码——码只走 owner 通道（飞书/微信推送），
      // 防 AI 通道拿到码后自批（approve_op 用 owner token 调用，AI 有 token）
      return { result: { content: [{ type: 'text', text: JSON.stringify({ id: result.id, status: 'pending', expiresInSec: result.expiresInSec, note: '确认码已推送至飞书/微信，owner 回复后即可完成注册' }) }] } };
    }
    case 'revoke_device': {
      const name = String(args.name ?? '').trim();
      if (!name) return { error: { code: -32602, message: 'name required' } };
      const removed = await revokeDevice(name);
      if (!removed) return { error: { code: -32602, message: 'device not found' } };
      return { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, revoked: name }) }] } };
    }
    case 'query_audit': {
      const limit = Math.min(Number(args.limit) || 50, 1000);
      const device = args.device ? String(args.device) : undefined;
      const entries = queryAudit(limit, device);
      return { result: { content: [{ type: 'text', text: JSON.stringify(entries) }] } };
    }
    case 'push_message': {
      const text = String(args.text ?? '').slice(0, 500);
      if (!text) return { error: { code: -32602, message: 'text required' } };
      const result = await push(text);
      return { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    case 'chat_ai': {
      const message = String(args.message ?? '').trim();
      if (!message) return { error: { code: -32602, message: 'message required' } };
      // Default to the shared `main` session — feishu/weixin conversations route
      // there too, so GCA continues the same conversation with full context.
      const sessionKey = String(args.sessionKey ?? 'main').slice(0, 512);
      try {
        const { getAgent } = await import('./agents/index.js');
        const result = await getAgent().chat(message, sessionKey);
        return { result: { content: [{ type: 'text', text: JSON.stringify({ sessionKey, runId: result.runId, text: result.text }) }] } };
      } catch (err) {
        return { error: { code: -32603, message: `chat_ai failed: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Mount MCP endpoint on the existing HTTP server. Returns true if handled. */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
  // Only /mcp
  if (url !== '/mcp') return false;

  // Auth（S5：constant-time 比对——此前明文 === 存在时序侧信道）
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const authed = !TOKEN || (!!presented && tokenEqual(presented, TOKEN));
  if (!authed) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unauthorized' }, id: null }));
    return true;
  }

  // POST — JSON-RPC request
  if (req.method === 'POST') {
    let body = '';
    let over = false;
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) {
          over = true;
          req.destroy(); // 内存 DoS 防护（2026-08-11 审查：此前无上限）
          break;
        }
      }
    } catch {
      /* stream destroyed */
    }
    if (over) return true;
    let msg: McpRequest;
    try {
      msg = JSON.parse(body);
    } catch {
      jsonResponse(res, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return true;
    }

    switch (msg.method) {
      case 'initialize':
        return jsonResponse(res, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'gca-server', version: '0.5.0' },
          },
        }), true;
      case 'notifications/initialized':
        // MCP 规范：notification 不应有响应（S15：此前返回带 id 的响应，低危违规）
        return true;
      case 'tools/list':
        return jsonResponse(res, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }), true;
      case 'tools/call': {
        const out = await handleToolsCall(msg.id, msg.params ?? {});
        return jsonResponse(res, { jsonrpc: '2.0', id: msg.id, ...out }), true;
      }
      default:
        return jsonResponse(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }), true;
    }
  }

  // Other methods not supported
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null }));
  return true;
}
