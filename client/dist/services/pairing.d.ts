/**
 * Pairing - bearer-token authentication for MCP endpoints.
 *
 * Closes the "anyone on the LAN can call every tool" hole and lays the
 * identity foundation for GAP-v2 (device ↔ gateway mutual trust).
 *
 * Token resolution order:
 *   1. GCA_MCP_TOKEN env (override)
 *   2. settings.json key `security.mcpToken` (persistent, written by setup:pairing)
 *   3. none → open mode (dev default; a warning is logged at startup)
 *
 * The token authenticates the GATEWAY to the DEVICE (the gateway presents it
 * as `Authorization: Bearer <token>` on every MCP call).
 */
import type express from 'express';
/** Generates a fresh pairing token (256-bit, hex). */
export declare function generatePairingToken(): string;
/** The effective pairing token, or null when running open (dev mode). */
export declare function getPairingToken(): Promise<string | null>;
/**
 * Express middleware: requires `Authorization: Bearer <pairing token>` when
 * a token is configured. Mount on every MCP-facing endpoint (/mcp, /sse,
 * /messages). /health stays open (it leaks nothing beyond liveness).
 */
export declare function requirePairing(): express.RequestHandler;
/** Startup hint so open mode is never silent. */
export declare function logPairingState(): Promise<void>;
