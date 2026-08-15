/**
 * gca-server CLI — manage the control plane daemon.
 *
 *   gca-server start          Start in background
 *   gca-server stop           Stop the daemon
 *   gca-server status         Check health
 *   gca-server setup          Generate token + systemd service
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig } from './config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(os.homedir(), '.gca-server', 'pid');
const PORT = serverConfig.port;
async function fetchHealth() {
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok ? await res.json() : null;
    }
    catch {
        return null;
    }
}
async function readPid() {
    try {
        const text = await readFile(PID_FILE, 'utf8');
        return Number(text.trim()) || null;
    }
    catch {
        return null;
    }
}
async function cmdStart() {
    const h = await fetchHealth();
    if (h) {
        console.log(`gca-server already running (uptime ${h.uptime}s)`);
        return;
    }
    await mkdir(path.dirname(PID_FILE), { recursive: true });
    const serverJs = path.resolve(__dirname, 'gca-server.js');
    const child = spawn('node', [serverJs], {
        cwd: path.resolve(__dirname, '..', '..'),
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    if (child.pid)
        await writeFile(PID_FILE, String(child.pid));
    console.log(`gca-server starting (pid ${child.pid})...`);
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const h2 = await fetchHealth();
        if (h2) {
            console.log(`started ✓ (port ${PORT}, uptime ${h2.uptime}s)`);
            return;
        }
    }
    console.error('start timed out — check logs');
    process.exitCode = 1;
}
async function cmdStop() {
    const pid = await readPid();
    if (!pid) {
        console.log('gca-server not running (no pid file)');
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
        console.log(`stopped (pid ${pid})`);
    }
    catch {
        console.log('process not found, removing stale pid file');
    }
    try {
        await unlink(PID_FILE);
    }
    catch { }
}
async function cmdStatus() {
    const h = await fetchHealth();
    console.log(`gca-server: ${h ? `UP (uptime ${h.uptime}s, port ${PORT})` : 'DOWN'}`);
    console.log(`token:      ${serverConfig.token ? 'configured ✓' : 'NOT CONFIGURED ✗'}`);
    console.log(`openclaw:   ${serverConfig.openclawBin}`);
    console.log(`config:     ${serverConfig.openclawConfig}`);
}
async function cmdSetup() {
    const isLinux = os.platform() === 'linux';
    const tokenPath = path.join(os.homedir(), 'gap-relay', 'token.txt');
    let token = serverConfig.token;
    if (!token) {
        token = randomBytes(32).toString('hex');
        await mkdir(path.dirname(tokenPath), { recursive: true });
        await writeFile(tokenPath, token, 'ascii');
        console.log(`Token generated: ${tokenPath}`);
    }
    else {
        console.log(`Token already exists: ${tokenPath}`);
    }
    if (isLinux) {
        const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
        const unitPath = path.join(unitDir, 'gca-server.service');
        const cwd = path.resolve(__dirname, '..', '..');
        // S7 修复：
        //   1. ExecStart 用编译产物 node dist/gca-server.js（此前 src/server/ 路径不存在，
        //      生成的 unit 无法启动）
        //   2. token 不写进 unit 的 Environment=（unit 默认 644 权限，本机其他用户可读）——
        //      改走 EnvironmentFile=%h/<服务端token环境文件>（0600，仅当前用户可读）
        const envFile = path.join(os.homedir(), 'gap-relay', 'token.env');
        await mkdir(path.dirname(envFile), { recursive: true });
        await writeFile(envFile, `GCA_SERVER_TOKEN=${token}\n`, { mode: 0o600 });
        const serverJs = path.join(cwd, 'dist', 'gca-server.js');
        const unit = `[Unit]
Description=GCA Control Plane (gca-server)
After=network.target

[Service]
WorkingDirectory=${cwd}
EnvironmentFile=%h/<服务端token环境文件>
ExecStart=/usr/bin/env node ${serverJs}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
        await mkdir(unitDir, { recursive: true });
        await writeFile(unitPath, unit, { mode: 0o600 });
        console.log(`systemd service: ${unitPath}`);
        console.log(`token env file:  ${envFile} (0600)`);
        console.log('');
        console.log('Enable and start:');
        console.log('  systemctl --user daemon-reload');
        console.log('  systemctl --user enable --now gca-server');
    }
    console.log('');
    console.log('Setup complete. Next: gca-server start');
}
const cmd = process.argv[2];
const commands = {
    start: cmdStart,
    stop: cmdStop,
    status: cmdStatus,
    setup: cmdSetup,
};
if (!cmd || !commands[cmd]) {
    console.log(`gca-server — GCA Control Plane CLI

commands:
  start          Start the daemon in background
  stop           Stop the daemon
  status         Check health and configuration
  setup          Generate token + systemd service file`);
    process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
//# sourceMappingURL=cli.js.map