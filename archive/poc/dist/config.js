/**
 * Central device/server configuration (S-002).
 *
 * Reads environment variables once at startup, applies defaults, and exposes
 * a single typed config object. Replaces scattered `Number(process.env.X)`
 * reads across transports, services, and the entry point.
 *
 * Device/connection metadata lives here too (deviceName is what the gateway
 * sees as the MCP server identity).
 */
import os from 'node:os';
/** Positive finite number from env, else fallback. */
function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function loadConfig() {
    return {
        port: num(process.env.PORT, 3001),
        deviceName: process.env.DEVICE_NAME || `gca-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
        logLevel: process.env.LOG_LEVEL || 'info',
        exec: {
            timeoutMs: num(process.env.EXEC_TIMEOUT, 30_000),
            maxOutputBytes: num(process.env.EXEC_MAX_OUTPUT, 1_048_576),
        },
        approval: {
            ttlMs: num(process.env.APPROVAL_TTL_MS, 5 * 60_000),
            totpWindowSteps: num(process.env.APPROVAL_TOTP_WINDOW, 2),
        },
        session: {
            ttlMs: num(process.env.MCP_SESSION_TTL_MS, 30 * 60_000),
            sweepMs: num(process.env.MCP_SESSION_SWEEP_MS, 60_000),
        },
        proxy: {
            http: process.env.HTTP_PROXY || process.env.http_proxy || undefined,
            https: process.env.HTTPS_PROXY || process.env.https_proxy || undefined,
            socks: process.env.SOCKS_PROXY || process.env.socks_proxy || undefined,
            bypass: (process.env.NO_PROXY || process.env.no_proxy || '')
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean),
        },
        security: {
            mcpToken: process.env.GCA_MCP_TOKEN || undefined,
        },
        gap: {
            relayUrl: process.env.GAP_RELAY_URL || 'http://<网关IP>:18790',
        },
    };
}
export const config = loadConfig();
//# sourceMappingURL=config.js.map