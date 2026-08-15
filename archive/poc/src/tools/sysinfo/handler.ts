/**
 * sysinfo Tool Handler - returns a snapshot of host system information.
 *
 * Read-only operation, no approval required.
 *
 * Uses only Node.js built-ins (os + fs.statfs) so the tool has zero
 * external dependencies. Notes:
 *   - os.loadavg() returns [0,0,0] on Windows (POSIX-only metric)
 *   - Disk stats cover the system drive of the current working directory
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import os from 'node:os';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';
import type { SysinfoOkResult } from '../../types/tools.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function sysinfoHandler() {
  logger.info('sysinfo tool called');

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage of the volume hosting the current working directory.
  // fs.statfs is available on all platforms since Node 18.15.
  let disk: SysinfoOkResult['disk'] = { error: 'unavailable' };
  try {
    const rootPath = path.parse(process.cwd()).root;
    const fsStat = await statfs(rootPath);
    const total = Number(fsStat.blocks) * Number(fsStat.bsize);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    disk = {
      path: rootPath,
      totalGB: round1(total / GB),
      freeGB: round1(free / GB),
      usedPercent: total > 0 ? round1(((total - free) / total) * 100) : null,
    };
  } catch (err) {
    logger.warn('sysinfo: disk stats unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Non-internal IPv4 addresses, one line per interface
  const network: Array<{ name: string; address: string; mac: string }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        network.push({ name, address: addr.address, mac: addr.mac });
      }
    }
  }

  const body: SysinfoOkResult = {
    status: 'ok',
    hostname: os.hostname(),
    os: {
      platform: os.platform(),
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      uptimeHours: round1(os.uptime() / 3600),
    },
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? null,
      loadAvg: os.loadavg(),
      loadAvgNote: os.platform() === 'win32' ? 'always [0,0,0] on Windows' : null,
    },
    memory: {
      totalMB: Math.round(totalMem / MB),
      freeMB: Math.round(freeMem / MB),
      usedMB: Math.round(usedMem / MB),
      usedPercent: round1((usedMem / totalMem) * 100),
    },
    disk,
    network,
    collectedAt: new Date().toISOString(),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
