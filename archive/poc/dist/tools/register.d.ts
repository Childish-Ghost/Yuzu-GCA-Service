/**
 * Tool Registration - registers all MCP tools onto a server instance.
 *
 * Called for each new connection/session to avoid shared-state issues
 * between concurrent clients.
 *
 * Phase 2 tools: exec + confirm (approval loop) + file_list / file_read /
 * file_write / file_move + process_list + sysinfo.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare function registerTools(server: McpServer): void;
