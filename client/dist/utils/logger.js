/**
 * Structured logger backed by pino.
 * Writes JSON lines to stderr so stdout stays clean for MCP JSON-RPC protocol.
 *
 * Call convention is logger.<level>(msg, meta) — meta fields are merged into
 * the JSON log line (pino's native order is (obj, msg), so we swap here and
 * keep all call sites unchanged).
 *
 * Level via LOG_LEVEL env (debug|info|warn|error), default 'info'.
 */
import { pino, destination, stdTimeFunctions } from 'pino';
import { config } from '../config.js';
const base = pino({
    level: config.logLevel,
    base: { service: 'gca-poc' },
    timestamp: stdTimeFunctions.isoTime,
}, destination({ fd: 2 }));
export const logger = {
    debug(msg, meta) {
        base.debug(meta ?? {}, msg);
    },
    info(msg, meta) {
        base.info(meta ?? {}, msg);
    },
    warn(msg, meta) {
        base.warn(meta ?? {}, msg);
    },
    error(msg, meta) {
        base.error(meta ?? {}, msg);
    },
};
//# sourceMappingURL=logger.js.map