/**
 * GCA CLI - device management commands (P-005).
 *
 *   gca start              Start the MCP server (background, logs to logs/dev-server.log)
 *   gca stop               Stop the MCP server
 *   gca status             Health / sessions / pairing / TOTP state
 *   gca doctor             Full diagnostics (port, auth, relay, tools, self-check)
 *   gca logs [n]           Print the last n lines of the server log (default 30)
 *   gca setup              Interactive first-run wizard (device name, port)
 *   gca service install    Register auto-start at login (schtasks / systemd --user)
 *   gca service uninstall  Remove auto-start
 *   gca service status     Auto-start registration state
 *
 * Zero dependencies beyond the project's own modules.
 */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { getSetting, setSetting } from './services/settings-store.js';
import { getPairingToken, logPairingState } from './services/pairing.js';

const PORT = config.port;
const isWindows = os.platform() === 'win32';

// ---------- helpers ----------

interface RunResult {
  ok: boolean;
  code: number | string;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], options: object = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...options }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: (err as { code?: number | string } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function health(): Promise<{ uptime: number; activeSessions: number; device: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function findPidOnPort(): Promise<string | null> {
  if (!isWindows) return null;
  const r = await run('netstat', ['-ano']);
  const line = r.stdout.split('\n').find((l: string) => l.includes(`:${PORT}`) && l.includes('LISTENING'));
  return line ? line.trim().split(/\s+/).pop() ?? null : null;
}

// ---------- commands ----------

async function cmdStart() {
  const existing = await health();
  if (existing) {
    console.log(`already running (uptime ${Math.round(existing.uptime)}s, sessions ${existing.activeSessions})`);
    return;
  }
  const child = spawn('cmd', ['/c', 'npm run dev > logs\\dev-server.log 2>&1'], {
    cwd: path.resolve(process.cwd()),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log('starting...');
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await health();
    if (h) {
      console.log(`started ✓ (port ${PORT}, device ${h.device})`);
      return;
    }
  }
  console.error('start timed out — check logs/dev-server.log');
  process.exitCode = 1;
}

async function cmdStop() {
  const pid = await findPidOnPort();
  if (!pid) {
    console.log('not running');
    return;
  }
  await run('taskkill', ['/PID', pid, '/F']);
  console.log(`stopped (pid ${pid})`);
}

async function cmdStatus() {
  const h = await health();
  console.log(`server:   ${h ? `UP (uptime ${Math.round(h.uptime)}s, sessions ${h.activeSessions})` : 'DOWN'}`);
  const token = await getPairingToken();
  console.log(`pairing:  ${token ? 'configured ✓' : 'NOT CONFIGURED (open to network!)'}`);

  console.log(`device:   ${config.deviceName} · port ${PORT}`);
}

async function cmdDoctor() {
  let fails = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fails++;
  };

  const h = await health();
  check('server health', !!h, h ? `uptime ${Math.round(h.uptime)}s` : 'not responding');
  check('pairing token', !!(await getPairingToken()));

  // relay reachability
  let relayOk = false;
  try {
    const base = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    relayOk = res.ok;
  } catch {}
  check('gap-relay reachable', relayOk, config.gap.relayUrl);

  // MCP handshake via self-check
  try {
    const { runStartupSelfCheck } = await import('./utils/self-check.js');
    await runStartupSelfCheck(PORT);
    check('mcp handshake + tools', true);
  } catch (err) {
    check('mcp handshake + tools', false, err instanceof Error ? err.message : String(err));
  }

  const svc = await serviceStatus(false);
  check('auto-start registered', svc.registered, svc.detail);

  console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) failed.`);
  process.exitCode = fails === 0 ? 0 : 1;
}

async function cmdLogs(n = 30) {
  try {
    const text = await readFile(path.resolve('logs/dev-server.log'), 'utf8');
    const lines = text.trim().split('\n');
    for (const line of lines.slice(-n)) {
      try {
        const o = JSON.parse(line);
        const meta = Object.fromEntries(Object.entries(o).filter(([k]) => !['level', 'time', 'service', 'msg', 'pid', 'hostname'].includes(k)));
        console.log(`${(o.time ?? '').slice(11, 19)} ${o.msg ?? ''} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`);
      } catch {
        console.log(line);
      }
    }
  } catch {
    console.error('no log file (logs/dev-server.log)');
  }
}

async function cmdSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question(`device name [${config.deviceName}]: `)) || config.deviceName;
  const portStr = (await rl.question(`port [${PORT}]: `)) || String(PORT);
  rl.close();

  await setSetting('device.name', name);
  const port = Number(portStr);
  if (Number.isFinite(port) && port > 0 && port < 65536) {
    await setSetting('server.port', port);
  }
  console.log(`saved to settings.json (device.name=${name}, server.port=${port})`);
  console.log('next: npm run setup:pairing');
}

// ---------- service (auto-start) ----------

function startupVbsPath(): string {
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'gca-server.vbs',
  );
}

async function serviceStatus(verbose = true) {
  if (isWindows) {
    const { access } = await import('node:fs/promises');
    let registered = false;
    try {
      await access(startupVbsPath());
      registered = true;
    } catch {}
    const detail = registered ? 'Startup folder (logon, hidden)' : 'not registered';
    if (verbose) console.log(`auto-start: ${registered ? `registered ✓ ${detail}` : detail}`);
    return { registered, detail };
  }
  const r = await run('systemctl', ['--user', 'is-enabled', 'gca-mcp-server.service']);
  const registered = r.ok && r.stdout.trim() === 'enabled';
  if (verbose) console.log(`auto-start: ${registered ? 'enabled ✓ (systemd --user)' : 'not enabled'}`);
  return { registered, detail: registered ? 'systemd --user' : 'not enabled' };
}

async function cmdServiceInstall() {
  const cwd = path.resolve(process.cwd());
  if (isWindows) {
    // Startup-folder launcher: no admin, hidden window, runs at user logon.
    // Huorong AV blocks the node.exe process TREE from writing autostart
    // entries (EPERM for fs writes, silent kill for child powershell), so we
    // generate an installer .cmd — the user runs it once, like install-key.cmd.
    const wrapper = path.join(cwd, 'scripts', 'start-server.cmd');
    const vbsLocal = path.join(cwd, 'scripts', 'gca-server.vbs');
    await writeFile(vbsLocal, `CreateObject("Wscript.Shell").Run "cmd /c ""${wrapper}""", 0, False\r\n`, 'ascii');

    const installer = [
      '@echo off',
      'REM GCA autostart installer - run once by double-clicking',
      `copy /y "${vbsLocal}" "${startupVbsPath()}"`,
      'if exist "' + startupVbsPath() + '" (echo GCA autostart registered OK) else (echo FAILED)',
      'pause',
      '',
    ].join('\r\n');
    const installerPath = path.join(cwd, 'scripts', 'install-autostart.cmd');
    await writeFile(installerPath, installer, 'ascii');

    console.log('Huorong AV blocks node from writing autostart entries.');
    console.log('One manual step (like install-key.cmd):');
    console.log('');
    console.log(`  double-click:  ${installerPath}`);
    console.log('');
    console.log('then verify with: gca service status');
  } else {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const unit = `[Unit]
Description=GCA MCP Server
After=network.target

[Service]
WorkingDirectory=${cwd}
ExecStart=/usr/bin/env npm run dev
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, 'gca-mcp-server.service'), unit);
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', 'gca-mcp-server.service']);
    console.log('registered systemd --user service gca-mcp-server.service');
    console.log('tip: start it now with: systemctl --user start gca-mcp-server');
  }
}

async function cmdServiceUninstall() {
  if (isWindows) {
    const target = startupVbsPath();
    await run('powershell', ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`]);
    // vbs helper stays in scripts/ (harmless); the registered launcher is gone
    console.log('startup launcher removed');
  } else {
    await run('systemctl', ['--user', 'disable', '--now', 'gca-mcp-server.service']);
    console.log('systemd service disabled');
  }
}

// ---------- dispatch ----------

const [cmd, sub, ...rest] = process.argv.slice(2);

const commands: Record<string, () => Promise<void>> = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  doctor: cmdDoctor,
  logs: () => cmdLogs(Number(rest[0]) || Number(sub) || 30),
  setup: cmdSetup,
  service: async () => {
    if (sub === 'install') {
      await cmdServiceInstall();
      return;
    }
    if (sub === 'uninstall') {
      await cmdServiceUninstall();
      return;
    }
    await serviceStatus(true);
  },
  pair: async () => {
    // gca pair <code> [--server <url>]
    const code = sub;
    const serverIdx = rest.indexOf('--server');
    const serverUrl = serverIdx >= 0 ? rest[serverIdx + 1] : (process.env.GAP_RELAY_URL || config.gap.relayUrl);
    if (!code) {
      console.error('Usage: gca pair <pairing-code> [--server <url>]');
      console.error('Get a pairing code by running "gca pair-init" on the server/VM.');
      process.exitCode = 1;
      return;
    }
    if (!serverUrl) {
      console.error('No relay URL configured (set GAP_RELAY_URL or use --server)');
      process.exitCode = 1;
      return;
    }
    console.log(`Claiming pairing code ${code} at ${serverUrl}...`);
    try {
      // S1：设备自铸 token 随 claim 提交（服务端只存储，不再返回 owner token）
      const { ensureDeviceToken } = await import('./services/device-token.js');
      const deviceToken = await ensureDeviceToken();
      const machineId = process.env.GCA_MACHINE_ID || '';
      const res = await fetch(`${serverUrl}/pair/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: config.deviceName, port: config.port, deviceToken, machineId }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`Pairing failed: ${data.error || res.status}`);
        process.exitCode = 1;
        return;
      }
      // 保存设备 token；MCP token 同步为同一值——Gateway 经 openclaw.json
      // 的 Authorization（= deviceToken）接入设备 /mcp 时才能通过认证
      await setSetting('security.deviceToken', deviceToken);
      await setSetting('security.mcpToken', deviceToken);
      console.log(`\n✅ Paired successfully!`);
      console.log(`  Device: ${config.deviceName} at ${data.deviceIp}:${data.devicePort}`);
      console.log(`  Device token saved to settings.json (device-scoped, 与 owner token 隔离)`);
      console.log(`  Gateway auto-registered — run 'openclaw mcp reload' on the server if needed.`);
      console.log(`  Next: 'gca start' to begin serving.`);
    } catch (err) {
      console.error(`Cannot reach relay at ${serverUrl}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  },
  'pair-init': async () => {
    // gca pair-init — generates a one-time pairing code (run on the server/VM)
    const serverUrl = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    if (!serverUrl) {
      console.error('No relay URL configured (set GAP_RELAY_URL)');
      process.exitCode = 1;
      return;
    }
    let bearer = process.env.GCA_MCP_TOKEN;
    if (!bearer) {
      bearer = await getSetting<string>('security.mcpToken');
    }
    try {
      const res = await fetch(`${serverUrl}/pair/init`, {
        method: 'POST',
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`Failed: ${data.error || res.status}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n📋 Pairing code: ${data.code}`);
      console.log(`Expires in ${data.expiresInSec}s (10 minutes).`);
      console.log(`\nOn the new device, run:`);
      console.log(`  npm run gca -- pair ${data.code} --server ${serverUrl}`);
    } catch (err) {
      console.error(`Cannot reach relay: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  },
  devices: async () => {
    // gca devices — list all registered devices
    const serverUrl = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    if (!serverUrl) { console.error('No relay URL configured'); process.exitCode = 1; return; }
    let bearer = process.env.GCA_MCP_TOKEN;
    if (!bearer) { bearer = await getSetting<string>('security.mcpToken'); }
    try {
      const res = await fetch(`${serverUrl}/devices`, {
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) { console.error(`Failed: ${data.error || res.status}`); process.exitCode = 1; return; }
      console.log(`\n${data.count} device(s) registered:\n`);
      for (const d of data.devices) {
        console.log(`  ${d.name.padEnd(20)} ${d.url}`);
        console.log(`  ${' '.repeat(20)} transport: ${d.transport}, auth: ${d.hasAuth ? '✓' : '✗'}`);
      }
    } catch (err) {
      console.error(`Cannot reach relay: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  },
  audit: async () => {
    // gca audit [limit] — view recent audit log
    const serverUrl = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    if (!serverUrl) { console.error('No relay URL configured'); process.exitCode = 1; return; }
    let bearer = process.env.GCA_MCP_TOKEN;
    if (!bearer) { bearer = await getSetting<string>('security.mcpToken'); }
    const limit = sub || '20';
    try {
      const res = await fetch(`${serverUrl}/audit?limit=${limit}`, {
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) { console.error(`Failed: ${data.error || res.status}`); process.exitCode = 1; return; }
      console.log(`\n${data.count} audit entries (showing last ${limit}):\n`);
      for (const e of data.entries.slice(-Number(limit))) {
        const ts = new Date(e.ts).toISOString().slice(11, 19);
        console.log(`  ${ts} ${e.deviceId.padEnd(15)} ${e.action.padEnd(25)} ${e.status || ''} ${e.detail || ''}`);
      }
    } catch (err) {
      console.error(`Cannot reach relay: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  },
};

if (!cmd || !commands[cmd]) {
  console.log(`gca — GCA device CLI

commands:
  start | stop | status | doctor | logs [n] | setup
  service install | service uninstall | service status
  pair <code> [--server <url>]   — claim a pairing code (new device onboarding)
  pair-init                     — generate a one-time pairing code (run on server)
  devices                       — list all registered devices
  audit [n]                     — view recent audit log (default 20)
  revoke <device-name>          — revoke a device (remove from gateway)`);
  process.exit(cmd ? 1 : 0);
}

await commands[cmd]();
