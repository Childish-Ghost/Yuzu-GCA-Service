/**
 * gca-server configuration — all paths/ports from env, sensible defaults for Ubuntu VM.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

function findOpenclawBin(): string {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  // Try nvm
  const nvmBase = path.join(homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const p = path.join(nvmBase, v, 'bin', 'openclaw');
      try { readFileSync(p); return p; } catch {}
    }
  } catch {}
  // Try which
  try {
    const result = execSync('which openclaw 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) return result;
  } catch {}
  return '/usr/bin/openclaw';
}

function loadToken(): string {
  if (process.env.GCA_SERVER_TOKEN) return process.env.GCA_SERVER_TOKEN;
  const tokenPath = path.join(homedir(), 'gap-relay', 'token.txt');
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch {
    console.error('WARNING: no token found — set GCA_SERVER_TOKEN or create ~/<服务端token路径>');
    return '';
  }
}

/**
 * OpenClaw Gateway connection settings — env first, then the OpenClaw config
 * file (~/.openclaw/openclaw.json). Never hardcoded.
 */
function loadGatewayConfig(): { url: string; token: string } {
  const envUrl = process.env.OPENCLAW_GATEWAY_URL;
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envUrl) return { url: envUrl, token: envToken ?? '' };

  const configPath = process.env.OPENCLAW_CONFIG || path.join(homedir(), '.openclaw', 'openclaw.json');
  let fileToken = '';
  let filePort = 18789;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    // OpenClaw config shapes vary by version — probe common field locations
    const gateway = raw.gateway ?? raw.server ?? {};
    const gatewayAuth = gateway.auth ?? {};
    fileToken = String(gatewayAuth.token ?? gatewayAuth.password ?? gateway.token ?? gateway.password ?? raw.token ?? '');
    filePort = Number(gateway.port ?? gateway.wsPort ?? raw.port) || 18789;
  } catch {
    // No config file — fall back to defaults below
  }
  return {
    url: `ws://127.0.0.1:${filePort}`,
    token: envToken ?? fileToken,
  };
}

export const serverConfig = {
  port: Number(process.env.GCA_SERVER_PORT) || 18790,
  token: loadToken(),
  openclawBin: findOpenclawBin(),
  openclawConfig: process.env.OPENCLAW_CONFIG || path.join(homedir(), '.openclaw', 'openclaw.json'),
  gateway: loadGatewayConfig(),
  logLevel: (process.env.GCA_SERVER_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
};