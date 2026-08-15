/**
 * Device registry — read/write openclaw.json mcp.servers, atomic write.
 * Each device stores machineId (SMBIOS UUID) for stable identity matching.
 *
 * 2026-08-12 审查 S1 修复：设备 token 隔离——openclaw.json 的 Authorization
 * 只写设备自己铸造的 deviceToken，不再写入 owner 管理 token（此前设备持有
 * 与 owner 相同的凭据，可自批审批/撤销他人/读审计）。
 *
 * 2026-08-15 M7 修复：读-改-写竞态——并发注册/心跳/撤销/改名/换 token 各自
 * 读到不同时刻的快照后写回，后写覆盖先写（丢更新）。所有变更经 withConfigLock
 * 串行化，临界区内重读最新文件；writeConfig 成功后同步刷新内存缓存，避免瞬时
 * 读失败回退到过期快照。
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { serverConfig } from './config.js';
import { tokenEqual } from './consttime.js';
// 上次成功读取的配置缓存——读取失败（OpenClaw 重写 openclaw.json 的瞬间/瞬时
// IO 错误）时回退缓存，避免设备端点间歇 404（device not found）
let cachedConfig = {};
// 读-改-写串行化锁（M7）：gca-server 单进程部署，进程内 promise 链即足够。
// 所有会修改 openclaw.json 的操作必须在 withConfigLock 临界区内完成
// "重读最新文件 → 变更 → 原子写"，避免并发快照互相覆盖（丢更新）。
let writeTail = Promise.resolve();
function withConfigLock(fn) {
    const result = writeTail.then(fn, fn);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
}
async function readConfig() {
    try {
        cachedConfig = JSON.parse(await readFile(serverConfig.openclawConfig, 'utf8'));
        return cachedConfig;
    }
    catch {
        return cachedConfig ?? {};
    }
}
async function writeConfig(config) {
    const tmp = `${serverConfig.openclawConfig}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await rename(tmp, serverConfig.openclawConfig);
    cachedConfig = config; // 写入成功即刷新缓存，避免瞬时读失败回退过期快照（M7）
}
export async function listDevices() {
    const config = await readConfig();
    const servers = config.mcp?.servers ?? {};
    return Object.entries(servers)
        .filter(([name]) => name !== 'gca-server') // gca-server 是服务端自带，不是被控设备
        .map(([name, cfg]) => ({
        name,
        url: cfg.url,
        transport: cfg.transport || 'streamable-http',
        hasAuth: !!(cfg.headers?.Authorization),
        machineId: cfg.machineId || '',
    }));
}
/** 设备 MCP 端点信息（url + 网关持有的 Authorization），供代理转发使用。
 *  设备 token 只存在网关侧（openclaw.json），不暴露给 Desktop 客户端。 */
export async function getDeviceEndpoint(name) {
    const config = await readConfig();
    const server = config.mcp?.servers?.[name];
    if (!server)
        return null;
    return { url: server.url, auth: server.headers?.Authorization ?? '' };
}
export async function findDeviceByMachineId(machineId) {
    const config = await readConfig();
    const servers = config.mcp?.servers ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
        if (cfg.machineId === machineId)
            return { name, cfg };
    }
    return null;
}
/** 按名称查设备（/heartbeat 兜底：配对注册未带 machineId 时按名称匹配，S10 修复） */
export async function findDeviceByName(name) {
    const config = await readConfig();
    const server = config.mcp?.servers?.[name];
    return server ? { name, cfg: server } : null;
}
/** 按设备 token 反查设备名（constant-time 比对）——设备端认证用 */
export async function findDeviceByToken(token) {
    const config = await readConfig();
    const servers = config.mcp?.servers ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
        if (cfg.deviceToken && tokenEqual(cfg.deviceToken, token))
            return { name };
    }
    return null;
}
/** 设备 token 最小长度（客户端 generatePairingToken 为 64 hex） */
export const DEVICE_TOKEN_MIN_LENGTH = 32;
export function isValidDeviceToken(token) {
    return typeof token === 'string' && token.length >= DEVICE_TOKEN_MIN_LENGTH;
}
/**
 * 注册设备：deviceToken 由设备自己铸造并随注册请求携带，服务端只存储。
 * 不再接受 owner token——杜绝设备=owner 授权坍缩（S1）。
 */
export async function registerDevice(name, ip, port, deviceToken, machineId) {
    if (!isValidDeviceToken(deviceToken)) {
        throw new Error(`invalid deviceToken (min ${DEVICE_TOKEN_MIN_LENGTH} chars)`);
    }
    await withConfigLock(async () => {
        const config = await readConfig();
        config.mcp = config.mcp ?? {};
        config.mcp.servers = config.mcp.servers ?? {};
        config.mcp.servers[name] = {
            url: `http://${ip}:${port}/mcp`,
            transport: 'streamable-http',
            headers: { Authorization: `Bearer ${deviceToken}` },
            deviceToken,
            ...(machineId ? { machineId } : {}),
        };
        await writeConfig(config);
    });
    reloadGateway();
}
/** 换发设备 token（owner 端 /devices/:name/retoken）——设备泄露后自助轮换 */
export async function updateDeviceToken(name, newToken) {
    if (!isValidDeviceToken(newToken))
        return false;
    const ok = await withConfigLock(async () => {
        const config = await readConfig();
        const server = config.mcp?.servers?.[name];
        if (!server)
            return false;
        server.deviceToken = newToken;
        server.headers = { ...(server.headers ?? {}), Authorization: `Bearer ${newToken}` };
        await writeConfig(config);
        return true;
    });
    if (ok)
        reloadGateway();
    return ok;
}
export async function revokeDevice(name) {
    const ok = await withConfigLock(async () => {
        const config = await readConfig();
        const servers = config.mcp?.servers;
        if (!servers?.[name])
            return false;
        delete servers[name];
        await writeConfig(config);
        return true;
    });
    if (ok)
        reloadGateway();
    return ok;
}
export async function renameDevice(oldName, newName) {
    const ok = await withConfigLock(async () => {
        const config = await readConfig();
        const servers = config.mcp?.servers;
        if (!servers?.[oldName])
            return false;
        servers[newName] = servers[oldName];
        delete servers[oldName];
        await writeConfig(config);
        return true;
    });
    if (ok)
        reloadGateway();
    return ok;
}
export async function updateDeviceUrl(name, newUrl) {
    const ok = await withConfigLock(async () => {
        const config = await readConfig();
        const server = config.mcp?.servers?.[name];
        if (!server)
            return false;
        server.url = newUrl;
        await writeConfig(config);
        return true;
    });
    if (ok)
        reloadGateway();
    return ok;
}
function reloadGateway() {
    execFile(serverConfig.openclawBin, ['mcp', 'reload'], { timeout: 15000 }, () => { });
}
//# sourceMappingURL=devices.js.map