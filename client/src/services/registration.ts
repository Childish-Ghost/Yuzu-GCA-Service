/**
 * Registration check — client verifies device registration status with gca-server.
 *
 * On startup:
 *   1. GET /device/me（设备 token 认证）判断是否已注册
 *   2. 未注册 → POST /register（携自铸 deviceToken）请求 owner 审批
 *   3. While unregistered: only sysinfo tool is available
 *   4. Once registered: all 20 tools available
 *
 * S1 修复（2026-08-12 审查）：设备用自己的 deviceToken 认证——
 * 不再用 owner/MCP token 读全量 /devices 列表。
 */
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getDeviceToken } from './device-token.js';

const SERVER_URL = process.env.GCA_SERVER_URL || config.gap.relayUrl;
const DEVICE_NAME = config.deviceName;

let _registered = false;
let _checkDone = false;

export function isRegistered(): boolean {
  return _registered;
}

export function setRegistered(v: boolean): void {
  _registered = v;
}

export async function checkRegistration(): Promise<boolean> {
  if (_checkDone) return _registered;
  _checkDone = true;

  // Desktop 等前端负责注册时，禁用自动注册（避免双注册）
  if (process.env.GCA_AUTO_REGISTER === '0') {
    logger.info('Auto-register disabled by GCA_AUTO_REGISTER=0 (managed by frontend)');
    _registered = true; // 前端会引导用户注册，工具全部可用
    return true;
  }

  const token = await getDeviceToken();
  if (!token) {
    logger.warn('No device token — running in open mode (all tools available)');
    _registered = true;
    return true;
  }

  try {
    // 注册状态自查询（S1：设备 token 认证，不读全量设备列表）
    const res = await fetch(`${SERVER_URL}/device/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      logger.info('Device registered with gca-server', { device: DEVICE_NAME });
      _registered = true;
      return true;
    }

    // 未注册（401 token 未登记 / 404 待审批中）→ 请求注册（带 machineId + 端口 + deviceToken）
    logger.info('Device not registered, requesting registration...', { device: DEVICE_NAME });
    const machineId = process.env.GCA_MACHINE_ID || '';
    const regRes = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceName: DEVICE_NAME, machineId, port: config.port, deviceToken: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (regRes.ok) {
      const regData = await regRes.json();
      // 设备通道响应不含确认码（M6）——码只走 owner 通道
      logger.info('Registration request sent, waiting for owner approval', { id: regData.id });
      // Poll for approval
      for (let i = 0; i < 60; i++) { // 5 min max
        await new Promise(r => setTimeout(r, 5000));
        const statusRes = await fetch(`${SERVER_URL}/ops/${regData.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData.status === 'approved') {
            logger.info('Device registration approved!');
            _registered = true;
            return true;
          }
          if (statusData.status === 'rejected' || statusData.status === 'expired') {
            logger.warn('Device registration was rejected or expired');
            break;
          }
        }
      }
    } else {
      logger.warn('Registration request failed', { status: regRes.status });
    }
  } catch (err) {
    logger.warn('Registration check failed, allowing all tools', {
      error: err instanceof Error ? err.message : String(err),
    });
    _registered = true; // network error → allow all (dev mode)
    return true;
  }

  logger.warn('Device NOT registered — only sysinfo tool available');
  return false;
}

/**
 * Heartbeat — 定期上报当前 IP，gca-server 自动更新设备 URL。
 * 解决 DHCP 重新分配 IP 后 Gateway 连不上设备的问题。
 * S1：设备 token 认证（服务端按 machineId/deviceName 定位后比对）。
 */
let _heartbeatStarted = false;

export function startHeartbeat(): void {
  if (_heartbeatStarted) return;
  _heartbeatStarted = true;

  const serverUrl = process.env.GCA_SERVER_URL || config.gap?.relayUrl;
  const machineId = process.env.GCA_MACHINE_ID || '';
  getDeviceToken().then((token) => {
    if (!serverUrl || !machineId || !token) {
      logger.info('Heartbeat skipped (missing config)', { hasUrl: !!serverUrl, hasMachineId: !!machineId, hasToken: !!token });
      return;
    }

    const beat = async () => {
      try {
        const res = await fetch(`${serverUrl}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ machineId, port: config.port }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { updated?: boolean; url?: string };
          if (data.updated) {
            logger.info('Device IP updated on gca-server', { url: data.url });
          }
        } else {
          logger.warn('Heartbeat rejected', { status: res.status });
        }
      } catch {
        // 心跳失败静默（服务器不可达时下次重试）
      }
    };

    beat();
    setInterval(beat, 60 * 1000);
    logger.info('Heartbeat started', { intervalSec: 60, machineId: machineId.slice(0, 8) });
  });
}