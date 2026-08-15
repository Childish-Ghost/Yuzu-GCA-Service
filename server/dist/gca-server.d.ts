/**
 * gca-server — GCA control plane daemon.
 *
 * Endpoints（2026-08-12 审查后鉴权矩阵：owner = 管理 token；device = 设备自铸 token）：
 *   GET  /health                              无
 *   POST /pair/init      owner（限速 30/时/IP）      — 生成 6 位配对码
 *   POST /pair/claim     无（限速 10/分/IP）          — 设备携自铸 deviceToken 注册
 *   GET  /devices        owner
 *   POST /devices/:name/revoke  owner
 *   POST /devices/:name/rename  owner
 *   POST /devices/:name/reurl   owner（SSRF 校验）
 *   POST /devices/:name/retoken owner（换发设备 token）
 *   POST /push            owner
 *   POST /clipboard/push  owner | device（device 时 deviceId 由服务端覆盖）
 *   GET  /clipboard/latest owner | device
 *   POST /ops/request     device（响应不含确认码）    — 高危操作申请
 *   POST /ops/approve     owner（限速 60/分/IP+全局） — 确认码批准
 *   POST /ops/reject      owner
 *   GET  /ops/:id         owner | op 归属设备（响应不含确认码）
 *   POST /register        owner | device（限速 10/时/IP）— 注册审批（设备携 deviceToken）
 *   POST /heartbeat       device（按 machineId/deviceName 定位设备后比对）
 *   POST /audit           owner | device（device 时 deviceId 由服务端覆盖）
 *   GET  /audit?limit=N&device=X  owner
 *   GET  /events          owner
 *   POST /mcp             owner（管理 MCP）
 *
 * Zero dependencies — Node.js built-in http only.
 */
import http from 'node:http';
export declare function safeUrl(raw: string): Promise<string | null>;
export declare function startServer(port?: number): http.Server;
