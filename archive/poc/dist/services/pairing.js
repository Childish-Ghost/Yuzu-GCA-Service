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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getSetting } from './settings-store.js';
import { logger } from '../utils/logger.js';
const TOKEN_SETTING_KEY = 'security.mcpToken';
/** Generates a fresh pairing token (256-bit, hex). */
export function generatePairingToken() {
    return randomBytes(32).toString('hex');
}
/** The effective pairing token, or null when running open (dev mode). */
export async function getPairingToken() {
    // env read per call (not via static config) so tests/rotation can change
    // it without a process restart — same pattern as credential-store paths.
    const fromEnv = process.env.GCA_MCP_TOKEN;
    if (fromEnv)
        return fromEnv;
    const fromSettings = await getSetting(TOKEN_SETTING_KEY);
    return fromSettings ?? null;
}
function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/**
 * Express middleware: requires `Authorization: Bearer <pairing token>` when
 * a token is configured. Mount on every MCP-facing endpoint (/mcp, /sse,
 * /messages). /health stays open (it leaks nothing beyond liveness).
 */
export function requirePairing() {
    return async (req, res, next) => {
        const token = await getPairingToken();
        if (!token) {
            next();
            return;
        }
        const header = req.headers.authorization ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!presented || !safeEqual(presented, token)) {
            logger.warn('MCP request rejected: missing or invalid pairing token', {
                path: req.path,
                ip: req.ip,
            });
            res.status(401).json({ error: 'Unauthorized: valid Bearer token required' });
            return;
        }
        next();
    };
}
/** Startup hint so open mode is never silent. */
export async function logPairingState() {
    const token = await getPairingToken();
    if (token) {
        logger.info('Pairing enabled: MCP endpoints require Bearer token', { source: config.security.mcpToken ? 'env' : 'settings' });
    }
    else {
        logger.warn('Pairing NOT configured: MCP endpoints are OPEN to the network (run npm run setup:pairing)');
    }
}
//# sourceMappingURL=pairing.js.map