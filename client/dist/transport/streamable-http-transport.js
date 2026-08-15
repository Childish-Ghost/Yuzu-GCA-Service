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
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../tools/register.js';
import { config } from '../config.js';
import { requirePairing } from '../services/pairing.js';
import { logger } from '../utils/logger.js';
const DEVICE_NAME = config.deviceName;
// Sessions that never receive a DELETE would leak. Sweep idle ones:
// TTL defaults to 30 min, sweep runs every 60s (both env-overridable).
const SESSION_TTL_MS = config.session.ttlMs;
const SESSION_SWEEP_MS = config.session.sweepMs;
/**
 * Creates an Express Router implementing the MCP Streamable HTTP transport.
 * Mount it at /mcp on the main app.
 */
export function createStreamableHttpRouter() {
    const router = express.Router();
    const sessions = new Map();
    // Pairing: when a token is configured, every MCP call must bear it
    router.use(requirePairing());
    function getSession(req) {
        const sessionId = req.headers['mcp-session-id'];
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (session) {
            session.lastActivity = Date.now();
        }
        return session;
    }
    // Evict sessions that have been idle beyond TTL (client vanished without DELETE)
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [sessionId, session] of sessions) {
            if (now - session.lastActivity > SESSION_TTL_MS) {
                sessions.delete(sessionId);
                logger.info('Streamable HTTP session evicted (idle TTL)', {
                    sessionId,
                    idleMs: now - session.lastActivity,
                    remainingSessions: sessions.size,
                });
                session.transport.close().catch((err) => {
                    logger.warn('Error closing evicted session', { sessionId, error: err.message });
                });
            }
        }
    }, SESSION_SWEEP_MS);
    sweeper.unref();
    // --- POST: JSON-RPC requests from the client ---
    router.post('/', async (req, res) => {
        const existing = getSession(req);
        if (existing) {
            await existing.transport.handleRequest(req, res, req.body);
            return;
        }
        // No session — only an initialize request may start one
        if (!isInitializeRequest(req.body)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: no valid session. Send an initialize request first.',
                },
                id: null,
            });
            return;
        }
        const server = new McpServer({
            name: `gca-${DEVICE_NAME}`,
            version: '0.3.0',
        });
        registerTools(server);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                sessions.set(sessionId, { transport, server, connectedAt: new Date(), lastActivity: Date.now() });
                logger.info('Streamable HTTP session initialized', {
                    sessionId,
                    totalSessions: sessions.size,
                });
            },
        });
        transport.onclose = () => {
            const sessionId = transport.sessionId;
            if (sessionId) {
                sessions.delete(sessionId);
                logger.info('Streamable HTTP session closed', {
                    sessionId,
                    remainingSessions: sessions.size,
                });
            }
        };
        transport.onerror = (err) => {
            logger.error('Streamable HTTP transport error', { sessionId: transport.sessionId, error: err.message });
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });
    // --- GET: open the server→client event stream for a session ---
    router.get('/', async (req, res) => {
        const session = getSession(req);
        if (!session) {
            res.status(400).json({ error: 'Invalid or missing mcp-session-id header' });
            return;
        }
        await session.transport.handleRequest(req, res);
    });
    // --- DELETE: terminate a session ---
    router.delete('/', async (req, res) => {
        const session = getSession(req);
        if (!session) {
            res.status(400).json({ error: 'Invalid or missing mcp-session-id header' });
            return;
        }
        await session.transport.handleRequest(req, res);
    });
    return router;
}
//# sourceMappingURL=streamable-http-transport.js.map