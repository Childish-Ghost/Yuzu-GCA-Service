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

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerConfig {
  /** HTTP listen port (PORT, default 3001) */
  port: number;
  /** Device identity shown to the gateway (DEVICE_NAME, default 'gca-device') */
  deviceName: string;
  /** pino log level (LOG_LEVEL, default 'info') */
  logLevel: LogLevel;
  exec: {
    /** Per-command timeout (EXEC_TIMEOUT, default 30000ms) */
    timeoutMs: number;
    /** Stdout/stderr capture cap (EXEC_MAX_OUTPUT, default 1MB) */
    maxOutputBytes: number;
  };
  approval: {
    /** confirmToken lifetime (APPROVAL_TTL_MS, default 5min) */
    ttlMs: number;
    /** TOTP acceptance window in ±steps (APPROVAL_TOTP_WINDOW, default 2 = up to 150s validity) */
    totpWindowSteps: number;
  };
  session: {
    /** Idle streamable-http session eviction threshold (MCP_SESSION_TTL_MS, default 30min) */
    ttlMs: number;
    /** Eviction sweep interval (MCP_SESSION_SWEEP_MS, default 60s) */
    sweepMs: number;
  };
  proxy: {
    /** HTTP proxy URL for outbound (HTTP_PROXY) — plumbing for future outbound clients */
    http?: string;
    /** HTTPS proxy URL (HTTPS_PROXY) */
    https?: string;
    /** SOCKS5 proxy URL (SOCKS_PROXY) */
    socks?: string;
    /** Hosts that bypass the proxy (NO_PROXY, comma-separated suffixes) */
    bypass: string[];
  };
  security: {
    /** Pairing token override (GCA_MCP_TOKEN). When set (or present in
     *  settings as security.mcpToken), all MCP endpoints require
     *  `Authorization: Bearer <token>`. Empty = open (dev mode). */
    mcpToken?: string;
  };
  gap: {
    /** gap-relay push endpoint on the gateway VM (GAP_RELAY_URL). */
    relayUrl: string;
  };
}

/** Positive finite number from env, else fallback. */
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadConfig(): ServerConfig {
  return {
    port: num(process.env.PORT, 3001),
    deviceName: process.env.DEVICE_NAME || `gca-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
    logLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
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
      relayUrl: process.env.GAP_RELAY_URL || '',
    },
  };
}

export const config: ServerConfig = loadConfig();
