/**
 * Power Actions - executes confirmed power operations.
 *
 * shutdown/restart/sleep/hibernate map to fixed Windows commands;
 * wol builds a magic packet in pure Node (no dependencies).
 * Kept in a service so the confirm dispatcher stays thin.
 */
import dgram from 'node:dgram';
import { executeCommand } from './executor.js';
import { logger } from '../utils/logger.js';
/** Builds the 102-byte magic packet: 6×0xFF + 16×MAC. */
function buildMagicPacket(mac) {
    const hex = mac.replace(/[:-]/g, '');
    if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
        throw new Error(`Invalid MAC address: ${mac}`);
    }
    const macBuf = Buffer.from(hex, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) {
        macBuf.copy(packet, 6 + i * 6);
    }
    return packet;
}
async function sendWol(mac) {
    const packet = buildMagicPacket(mac);
    await new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', reject);
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(packet, 9, '255.255.255.255', (err) => {
                sock.close();
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    });
}
export async function executePowerAction(input) {
    const { action, mac } = input;
    // Floor the delay at 30s for shutdown/restart: always leave an abort
    // window (power action 'abort' → shutdown /a), even if 0 was requested.
    const delaySec = action === 'shutdown' || action === 'restart'
        ? Math.max(input.delaySec ?? 30, 30)
        : (input.delaySec ?? 30);
    const isWindows = process.platform === 'win32';
    const delayMin = Math.max(1, Math.round(delaySec / 60));
    switch (action) {
        case 'shutdown': {
            const cmd = isWindows ? `shutdown /s /t ${delaySec}` : `shutdown -h +${delayMin}`;
            const r = await executeCommand(cmd, { timeout: 10000 });
            if (r.exitCode !== 0)
                throw new Error(r.stderr || `shutdown exited ${r.exitCode}`);
            return `Shutdown scheduled in ${delaySec}s (abort with: ${isWindows ? 'shutdown /a' : 'shutdown -c'})`;
        }
        case 'restart': {
            const cmd = isWindows ? `shutdown /r /t ${delaySec}` : `shutdown -r +${delayMin}`;
            const r = await executeCommand(cmd, { timeout: 10000 });
            if (r.exitCode !== 0)
                throw new Error(r.stderr || `shutdown exited ${r.exitCode}`);
            return `Restart scheduled in ${delaySec}s (abort with: ${isWindows ? 'shutdown /a' : 'shutdown -c'})`;
        }
        case 'sleep': {
            const cmd = isWindows ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0' : 'systemctl suspend';
            const r = await executeCommand(cmd, { timeout: 10000 });
            if (r.exitCode !== 0)
                throw new Error(r.stderr || `sleep exited ${r.exitCode}`);
            return 'Sleep initiated';
        }
        case 'hibernate': {
            const cmd = isWindows ? 'shutdown /h' : 'systemctl hibernate';
            const r = await executeCommand(cmd, { timeout: 10000 });
            if (r.exitCode !== 0)
                throw new Error(r.stderr || `hibernate exited ${r.exitCode} (is hibernation enabled?)`);
            return 'Hibernation initiated';
        }
        case 'wol': {
            if (!mac)
                throw new Error('wol requires a mac parameter');
            await sendWol(mac);
            logger.info('WoL magic packet sent', { mac });
            return `WoL magic packet broadcast to ${mac}`;
        }
        case 'abort': {
            const cmd = isWindows ? 'shutdown /a' : 'shutdown -c';
            const r = await executeCommand(cmd, { timeout: 10000 });
            if (r.exitCode !== 0)
                throw new Error(r.stderr || `abort exited ${r.exitCode} (no shutdown scheduled?)`);
            return 'Scheduled shutdown/restart aborted';
        }
    }
}
//# sourceMappingURL=power-actions.js.map