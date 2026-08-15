/**
 * Registration check — client verifies device registration status with gca-server.
 *
 * On startup:
 *   1. Check if device is in gca-server's device list
 *   2. If not, POST /register to request owner approval
 *   3. While unregistered: only sysinfo tool is available
 *   4. Once registered: all 20 tools available
 *
 * Registration state is checked per-session by the tool register.
 */
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

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

  const token = process.env.GCA_MCP_TOKEN;
  if (!token) {
    logger.warn('No pairing token — running in open mode (all tools available)');
    _registered = true;
    return true;
  }

  try {
    const res = await fetch(`${SERVER_URL}/devices`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('Cannot reach gca-server for registration check', { status: res.status });
      _registered = true; // server unreachable → allow all tools (dev mode)
      return true;
    }
    const data = await res.json();
    const found = (data.devices as Array<{ name: string }>).some(d => d.name === DEVICE_NAME);
    if (found) {
      logger.info('Device registered with gca-server', { device: DEVICE_NAME });
      _registered = true;
      return true;
    }

    // Not registered — request registration
    logger.info('Device not registered, requesting registration...', { device: DEVICE_NAME });
    const regRes = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceName: DEVICE_NAME }),
      signal: AbortSignal.timeout(5000),
    });
    if (regRes.ok) {
      const regData = await regRes.json();
      logger.info('Registration request sent, waiting for owner approval', { code: regData.code });
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