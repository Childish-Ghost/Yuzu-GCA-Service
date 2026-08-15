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
export declare function runStartupSelfCheck(port: number): Promise<void>;
