/**
 * GCA POC Entry Point
 *
 * Starts the MCP Server with SSE transport.
 * OpenClaw Gateway connects to http://<this-host>:<PORT>/sse
 *
 * This file ONLY assembles components and starts the server.
 * Zero business logic lives here.
 */
import { createSseServer } from './transport/sse-transport.js';
import { createStreamableHttpRouter } from './transport/streamable-http-transport.js';
import { runStartupSelfCheck } from './utils/self-check.js';
import { logPairingState } from './services/pairing.js';
import { startClipboardSync } from './services/clipboard-sync-watcher.js';
import { checkRegistration, startHeartbeat } from './services/registration.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
const PORT = config.port;
const DEVICE_NAME = config.deviceName;
function start() {
    const app = createSseServer();
    // Streamable HTTP transport (MCP spec 2025-03-26+) — the preferred transport.
    // Legacy /sse + /messages stay available during the Phase 1 transition.
    app.use('/mcp', createStreamableHttpRouter());
    const server = app.listen(PORT, () => {
        logger.info('GCA MCP Server started', {
            device: DEVICE_NAME,
            port: PORT,
            mcpEndpoint: `http://0.0.0.0:${PORT}/mcp (streamable-http, preferred)`,
            sseEndpoint: `http://0.0.0.0:${PORT}/sse (legacy)`,
            healthEndpoint: `GET http://0.0.0.0:${PORT}/health`,
        });
        // Check registration status with gca-server (non-fatal on failure)
        checkRegistration().catch((err) => {
            logger.warn('Registration check failed, running in dev mode', { error: err.message });
        });
        // P-006: prove the full stack works right after boot (non-fatal on failure)
        runStartupSelfCheck(PORT).catch((err) => {
            logger.error('Startup self-check FAILED', { error: err.message });
        });
        void logPairingState();
        // R-003: device-to-device clipboard sync (background, no AI)
        startClipboardSync();
        // 心跳：定期上报 IP，gca-server 自动更新设备 URL
        startHeartbeat();
    });
    // Graceful shutdown
    const shutdown = (signal) => {
        logger.info(`Received ${signal}, shutting down...`);
        server.close(() => {
            logger.info('Server closed');
            process.exit(0);
        });
        // Force exit after 5 seconds if close hangs
        setTimeout(() => {
            logger.error('Forced exit after timeout');
            process.exit(1);
        }, 5000);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
start();
//# sourceMappingURL=index.js.map