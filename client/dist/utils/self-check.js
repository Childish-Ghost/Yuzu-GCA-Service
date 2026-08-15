/**
 * Startup self-check (P-006 adapted): after the HTTP server starts, probe our
 * own endpoints to prove the whole stack works — not just that the port bound.
 *
 *   1. GET  /health                → HTTP stack alive
 *   2. POST /mcp (initialize)      → MCP handshake works, session created
 *   3. POST /mcp (tools/list)      → all tools registered
 *   4. DELETE /mcp session         → session teardown works
 *
 * Failures are logged at error level but never crash the server — a broken
 * self-check must not take down a possibly-working service.
 */
import { logger } from './logger.js';
import { getPairingToken } from '../services/pairing.js';
function parseSseBody(text) {
    for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
            try {
                return JSON.parse(line.slice(5).trim());
            }
            catch {
                // keep scanning
            }
        }
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
export async function runStartupSelfCheck(port) {
    const base = `http://127.0.0.1:${port}`;
    // Step 1: health endpoint
    const healthRes = await fetch(`${base}/health`);
    if (!healthRes.ok) {
        throw new Error(`/health returned ${healthRes.status}`);
    }
    // Step 2: MCP initialize over streamable HTTP
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
    };
    const pairingToken = await getPairingToken();
    if (pairingToken) {
        headers['Authorization'] = `Bearer ${pairingToken}`;
    }
    const initRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'startup-self-check', version: '1.0.0' },
            },
        }),
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    if (!initRes.ok || !sessionId) {
        throw new Error(`initialize failed: status=${initRes.status}, sessionId=${sessionId}`);
    }
    const sessionHeaders = { ...headers, 'mcp-session-id': sessionId };
    try {
        // Spec-required follow-up notification
        await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: sessionHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        // Step 3: tools/list — verify every tool registered
        const listRes = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: sessionHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        const parsed = parseSseBody(await listRes.text());
        const tools = parsed?.result?.tools?.map((t) => t.name) ?? [];
        if (tools.length === 0) {
            throw new Error(`tools/list returned no tools (error=${parsed?.error?.message ?? 'none'})`);
        }
        logger.info('Startup self-check passed', {
            health: 'ok',
            mcpHandshake: 'ok',
            tools,
        });
    }
    finally {
        // Step 4: always tear down the probe session
        await fetch(`${base}/mcp`, {
            method: 'DELETE',
            headers: { 'mcp-session-id': sessionId },
        }).catch(() => { });
    }
}
//# sourceMappingURL=self-check.js.map