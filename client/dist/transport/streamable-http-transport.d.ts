/**
 * Streamable HTTP Transport Layer (MCP spec 2025-03-26+)
 *
 * Single endpoint (mounted at /mcp) handling:
 *   POST   — client sends JSON-RPC; the initialize request creates a new
 *            McpServer + transport session, later requests route by the
 *            'mcp-session-id' header
 *   GET    — client opens the server→client event stream for a session
 *   DELETE — client terminates a session
 *
 * Same per-session McpServer design as the SSE transport: no shared state
 * between concurrent clients.
 *
 * Replaces the legacy /sse + /messages pair (kept for backward compatibility
 * during the Phase 1 transition).
 */
import express from 'express';
/**
 * Creates an Express Router implementing the MCP Streamable HTTP transport.
 * Mount it at /mcp on the main app.
 */
export declare function createStreamableHttpRouter(): express.Router;
