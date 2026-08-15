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
import { config, type LogLevel } from '../config.js';

export type { LogLevel };

const base = pino(
  {
    level: config.logLevel,
    base: { service: 'gca-poc' },
    timestamp: stdTimeFunctions.isoTime,
  },
  destination({ fd: 2 }), // stderr
);

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    base.debug(meta ?? {}, msg);
  },
  info(msg: string, meta?: Record<string, unknown>): void {
    base.info(meta ?? {}, msg);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    base.warn(meta ?? {}, msg);
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    base.error(meta ?? {}, msg);
  },
};
