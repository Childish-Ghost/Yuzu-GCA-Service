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
import { type LogLevel } from '../config.js';
export type { LogLevel };
export declare const logger: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
};
