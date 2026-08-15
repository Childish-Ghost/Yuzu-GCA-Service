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

export const serverConfig = {
  port: Number(process.env.GCA_SERVER_PORT) || 18790,
  token: loadToken(),
  openclawBin: findOpenclawBin(),
  openclawConfig: process.env.OPENCLAW_CONFIG || path.join(homedir(), '.openclaw', 'openclaw.json'),
  logLevel: (process.env.GCA_SERVER_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
};