/**
 * Audit Client (INT-003) — pushes operation logs to the gap-relay.
 *
 * Devices call audit() after confirmed operations so the server has a
 * centralized view of who-did-what-when across the fleet.
 */
import { config } from '../config.js';
export async function audit(entry) {
    const relay = process.env.GAP_RELAY_URL || config.gap.relayUrl;
    if (!relay)
        return;
    let bearer = process.env.GCA_MCP_TOKEN;
    if (!bearer) {
        const { getSetting } = await import('./settings-store.js');
        bearer = await getSetting('security.mcpToken');
    }
    try {
        await fetch(`${relay}/audit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            },
            body: JSON.stringify({
                ...entry,
                deviceId: entry.deviceId || config.deviceName,
                ts: Date.now(),
            }),
            signal: AbortSignal.timeout(5000),
        });
    }
    catch {
        // Non-blocking — audit is best-effort
    }
}
//# sourceMappingURL=audit-client.js.map