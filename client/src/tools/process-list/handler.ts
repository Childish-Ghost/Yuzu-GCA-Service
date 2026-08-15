/**
 * process_list Tool Handler - lists running processes.
 *
 * Read-only operation, no approval required (same level as `ps`/`tasklist`
 * which are on the exec readonly whitelist).
 *
 * Implementation: fixed platform commands parsed in JS — the user-supplied
 * filter is applied AFTER parsing, never interpolated into the command line,
 * so there is no injection surface.
 *   - Windows: PowerShell Get-Process (CPU seconds + working set)
 *   - Linux/macOS: ps with cumulative CPU time and RSS
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import os from 'node:os';
import { executeCommand } from '../../services/executor.js';
import { logger } from '../../utils/logger.js';
import type { ProcessInfo, ProcessListErrorResult, ProcessListOkResult } from '../../types/tools.js';
import type { ProcessListInput } from './schema.js';

const MB = 1024 * 1024;

function errorResult(error: string) {
  const body: ProcessListErrorResult = { status: 'error', error };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

async function listWindows(): Promise<ProcessInfo[]> {
  const ps =
    'powershell -NoProfile -NonInteractive -Command ' +
    '"Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json -Compress"';
  const result = await executeCommand(ps, { timeout: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`PowerShell exited ${result.exitCode}: ${result.stderr.substring(0, 200)}`);
  }
  const raw = JSON.parse(result.stdout) as
    | { Id: number; ProcessName: string; CPU: number | null; WorkingSet64: number }[]
    | { Id: number; ProcessName: string; CPU: number | null; WorkingSet64: number };
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((r) => ({
    pid: r.Id,
    name: r.ProcessName,
    cpuSec: r.CPU ?? null,
    memoryMB: Math.round((r.WorkingSet64 ?? 0) / MB),
  }));
}

async function listPosix(): Promise<ProcessInfo[]> {
  // pid, cumulative CPU time [[dd-]hh:]mm:ss, RSS KiB, command name
  const result = await executeCommand('ps -eo pid=,cputime=,rss=,comm=', { timeout: 15000 });
  if (result.exitCode !== 0) {
    throw new Error(`ps exited ${result.exitCode}: ${result.stderr.substring(0, 200)}`);
  }
  const rows: ProcessInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      cpuSec: parseCpuTime(m[2]),
      memoryMB: Math.round(Number(m[3]) / 1024),
      name: m[4],
    });
  }
  return rows;
}

function parseCpuTime(t: string): number | null {
  // [[dd-]hh:]mm:ss → seconds
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

const SORTERS: Record<string, (a: ProcessInfo, b: ProcessInfo) => number> = {
  cpu: (a, b) => (b.cpuSec ?? -1) - (a.cpuSec ?? -1),
  memory: (a, b) => b.memoryMB - a.memoryMB,
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => a.name.localeCompare(b.name),
};

export async function processListHandler(args: ProcessListInput) {
  const { sortBy = 'cpu', limit = 20, filter } = args;

  logger.info('process_list tool called', { sortBy, limit, filter });

  try {
    let processes = os.platform() === 'win32' ? await listWindows() : await listPosix();

    if (filter) {
      const needle = filter.toLowerCase();
      processes = processes.filter((p) => p.name.toLowerCase().includes(needle));
    }

    const total = processes.length;
    processes = processes.sort(SORTERS[sortBy]).slice(0, limit);

    const body: ProcessListOkResult = {
      status: 'ok',
      total,
      returned: processes.length,
      sortBy,
      processes,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  } catch (err) {
    logger.error('process_list failed', { error: err instanceof Error ? err.message : String(err) });
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
