/**
 * SSE Transport Layer
 *
 * Sets up Express HTTP server with two endpoints for MCP SSE transport:
 *   GET  /sse       — client opens persistent event stream, server creates
 *                     a new McpServer + SSEServerTransport per connection
 *   POST /messages  — client sends JSON-RPC requests, routed by sessionId
 *
 * Design decision: each /sse connection gets its own McpServer instance.
 * This prevents response cross-talk between concurrent clients.
 * (See MCP SDK docs: sharing a single server across connections is a known pitfall.)
 *
 * Also provides:
 *   GET  /health    — simple health check for monitoring
 */
import express from 'express';
/**
 * Creates and configures the Express application with SSE transport.
 * Returns the app instance — the caller decides which port to listen on.
 */
export declare function createSseServer(): express.Express;
