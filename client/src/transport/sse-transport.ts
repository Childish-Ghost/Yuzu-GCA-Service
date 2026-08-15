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
import { createReadStream } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerTools } from '../tools/register.js';
import { config } from '../config.js';
import { requirePairing } from '../services/pairing.js';
import { consumeTicket } from '../services/transfer-tickets.js';
import { logger } from '../utils/logger.js';

const DEVICE_NAME = config.deviceName;

interface SessionState {
  transport: SSEServerTransport;
  server: McpServer;
  connectedAt: Date;
}

/**
 * Creates and configures the Express application with SSE transport.
 * Returns the app instance — the caller decides which port to listen on.
 */
export function createSseServer(): express.Express {
  const app = express();
  app.use(express.json());

  // Track active SSE sessions by sessionId
  const sessions = new Map<string, SessionState>();

  // --- SSE endpoint: client connects here for the event stream ---
  app.get('/sse', requirePairing(), async (_req, res) => {
    // Create a fresh McpServer instance for this connection
    const server = new McpServer({
      name: `gca-${DEVICE_NAME}`,
      version: '0.3.0',
    });

    // Register all tools on this server instance
    registerTools(server);

    // Create SSE transport — '/messages' is the POST endpoint path
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;

    sessions.set(sessionId, { transport, server, connectedAt: new Date() });
    logger.info('SSE client connected', {
      sessionId,
      totalSessions: sessions.size,
    });

    // Connect the MCP server to this transport
    await server.connect(transport);

    // Clean up on disconnect
    res.on('close', () => {
      sessions.delete(sessionId);
      logger.info('SSE client disconnected', {
        sessionId,
        remainingSessions: sessions.size,
      });
    });
  });

  // --- Messages endpoint: client POSTs JSON-RPC requests here ---
  app.post('/messages', requirePairing(), async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found', sessionId });
      return;
    }

    // Delegate to the transport's message handler
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Data plane: one-shot file transfer download (C-007) ---
  // The ticket token IS the authorization (single-use, short TTL) — it is
  // deliberately NOT behind the pairing token, since the fetching device
  // proves authorization by possessing the ticket.
  app.get('/transfer/:token', (req, res) => {
    const ticket = consumeTicket(req.params.token);
    if (!ticket) {
      logger.warn('Transfer request with invalid/expired token', { ip: req.ip });
      res.status(404).json({ error: 'Invalid or expired transfer token' });
      return;
    }

    logger.info('Transfer download started', { path: ticket.path, size: ticket.size, ip: req.ip });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', ticket.size);
    res.setHeader('X-Transfer-Size', ticket.size);

    const stream = createReadStream(ticket.path);
    stream.on('error', (err) => {
      logger.error('Transfer stream failed', { path: ticket.path, error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read source file' });
      } else {
        res.destroy();
      }
    });
    stream.on('end', () => {
      logger.info('Transfer download completed', { path: ticket.path, size: ticket.size, ip: req.ip });
    });
    stream.pipe(res);
  });

  // --- Health check endpoint ---
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      device: DEVICE_NAME,
      activeSessions: sessions.size,
      uptime: process.uptime(),
    });
  });

  return app;
}
