/**
 * Clipboard Sync Watcher (R-003) - device-to-device clipboard sync (text + images).
 *
 * Runs as a background service alongside the MCP server:
 *   - Polls local clipboard every 2s; on change → push to relay
 *   - Polls relay for remote clipboard every 2s; on newer → set local
 *
 * No AI involvement — pure device-to-device, like Apple Universal Clipboard.
 * Config: GCA_CLIPBOARD_SYNC=1 to enable (default: on when relay is configured)
 */
import { getClipboardData, setClipboardData } from './clipboard.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
const POLL_MS = 2000;
const MAX_CONTENT = 5 * 1024 * 1024; // 5MB (images)
let lastLocal = { type: 'text', content: '' };
let lastRemoteUpdatedAt = 0;
let running = false;
function sameContent(a, b) {
    return a.type === b.type && a.content === b.content;
}
async function syncLoop() {
    const relay = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    if (!relay)
        return;
    // S1/S2：设备 token（服务端 /clipboard/* 现在要求 owner|device 认证，
    // 拉取不再是无鉴权的裸 GET）
    const { getDeviceToken } = await import('./device-token.js');
    const bearer = await getDeviceToken();
    while (running) {
        // --- Push: local clipboard changed? (independent try/catch) ---
        try {
            const local = await getClipboardData();
            if (!sameContent(local, lastLocal) && local.content.length <= MAX_CONTENT) {
                const res = await fetch(`${relay}/clipboard/push`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                    },
                    body: JSON.stringify({ content: local.content, type: local.type, deviceId: config.deviceName }),
                    signal: AbortSignal.timeout(15000),
                });
                if (res.ok) {
                    lastLocal = local; // only update after successful push
                    logger.info('Clipboard pushed to relay', { type: local.type, chars: local.content.length });
                }
                else {
                    logger.warn('Clipboard push rejected', { status: res.status });
                }
            }
        }
        catch (err) {
            logger.warn('Clipboard push failed', { error: err instanceof Error ? err.message : String(err) });
        }
        // --- Pull: relay has newer clipboard? (independent try/catch) ---
        try {
            const res = await fetch(`${relay}/clipboard/latest`, {
                headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
                signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
                const remote = await res.json();
                const remoteData = { type: remote.type || 'text', content: remote.content };
                if (remote.updatedAt > lastRemoteUpdatedAt && !sameContent(remoteData, lastLocal) && remote.deviceId !== config.deviceName) {
                    lastRemoteUpdatedAt = remote.updatedAt;
                    lastLocal = remoteData; // prevent echo
                    await setClipboardData(remoteData);
                    logger.info('Clipboard synced from remote', { fromDevice: remote.deviceId, type: remoteData.type, chars: remoteData.content.length });
                }
            }
        }
        catch {
            // Pull failure — just retry next cycle
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
export function startClipboardSync() {
    if (process.env.GCA_CLIPBOARD_SYNC === '0') {
        logger.info('Clipboard sync disabled by env', {});
        return;
    }
    if (running)
        return;
    running = true;
    syncLoop().catch((err) => logger.error('Clipboard sync crashed', { error: String(err) }));
    logger.info('Clipboard sync watcher started', { pollMs: POLL_MS });
}
export function stopClipboardSync() {
    running = false;
}
//# sourceMappingURL=clipboard-sync-watcher.js.map