/**
 * Device registry — read/write openclaw.json mcp.servers, atomic write.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { serverConfig } from './config.js';
async function readConfig() {
    try {
        const text = await readFile(serverConfig.openclawConfig, 'utf8');
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
async function writeConfig(config) {
    const tmp = `${serverConfig.openclawConfig}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await rename(tmp, serverConfig.openclawConfig);
}
export async function listDevices() {
    const config = await readConfig();
    const servers = config.mcp?.servers ?? {};
    return Object.entries(servers).map(([name, cfg]) => ({
        name,
        url: cfg.url,
        transport: cfg.transport || 'streamable-http',
        hasAuth: !!(cfg.headers?.Authorization),
    }));
}
export async function registerDevice(name, ip, port, token) {
    const config = await readConfig();
    const mcp = config.mcp ?? {};
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
export async function revokeDevice(name) {
    const config = await readConfig();
    const servers = config.mcp?.servers;
    if (!servers || !servers[name])
        return false;
    delete servers[name];
    await writeConfig(config);
    reloadGateway();
    return true;
}
export async function renameDevice(oldName, newName) {
    const config = await readConfig();
    const servers = config.mcp?.servers;
    if (!servers || !servers[oldName])
        return false;
    servers[newName] = servers[oldName];
    delete servers[oldName];
    await writeConfig(config);
    reloadGateway();
    return true;
}
export async function updateDeviceUrl(name, newUrl) {
    const config = await readConfig();
    const servers = config.mcp?.servers;
    if (!servers || !servers[name])
        return false;
    servers[name].url = newUrl;
    await writeConfig(config);
    reloadGateway();
    return true;
}
function reloadGateway() {
    execFile(serverConfig.openclawBin, ['mcp', 'reload'], { timeout: 15000 }, () => { });
}
//# sourceMappingURL=devices.js.map