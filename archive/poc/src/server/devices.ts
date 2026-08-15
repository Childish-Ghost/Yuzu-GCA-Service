/**
 * Device registry — read/write openclaw.json mcp.servers, atomic write.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { serverConfig } from './config.js';

interface DeviceEntry {
  name: string;
  url: string;
  transport: string;
  hasAuth: boolean;
}

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(serverConfig.openclawConfig, 'utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  const tmp = `${serverConfig.openclawConfig}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await rename(tmp, serverConfig.openclawConfig);
}

export async function listDevices(): Promise<DeviceEntry[]> {
  const config = await readConfig();
  const servers = (config as { mcp?: { servers?: Record<string, { url: string; transport: string; headers?: { Authorization?: string } }> } }).mcp?.servers ?? {};
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    url: cfg.url,
    transport: cfg.transport || 'streamable-http',
    hasAuth: !!(cfg.headers?.Authorization),
  }));
}

export async function registerDevice(name: string, ip: string, port: number, token: string): Promise<void> {
  const config = await readConfig();
  const mcp = (config as { mcp?: { servers?: Record<string, unknown> } }).mcp ?? {};
  mcp.servers = mcp.servers ?? {};
  mcp.servers[name] = {
    url: `http://${ip}:${port}/mcp`,
    transport: 'streamable-http',
    headers: { Authorization: `Bearer ${token}` },
  };
  config.mcp = mcp;
  await writeConfig(config);
  reloadGateway();
}

export async function revokeDevice(name: string): Promise<boolean> {
  const config = await readConfig();
  const servers = (config as { mcp?: { servers?: Record<string, unknown> } }).mcp?.servers;
  if (!servers || !servers[name]) return false;
  delete servers[name];
  await writeConfig(config);
  reloadGateway();
  return true;
}

function reloadGateway(): void {
  execFile(serverConfig.openclawBin, ['mcp', 'reload'], { timeout: 15000 }, () => {});
}