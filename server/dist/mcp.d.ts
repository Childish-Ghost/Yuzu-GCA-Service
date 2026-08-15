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
/** Mount MCP endpoint on the existing HTTP server. Returns true if handled. */
export declare function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean>;
