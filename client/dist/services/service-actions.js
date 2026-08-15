/**
 * Service Actions - lists and controls system services.
 *
 * Windows: PowerShell Get-Service / *-Service. POSIX: systemctl.
 * Control actions typically need elevation — failures come back as
 * graceful errors, never crashes.
 */
import os from 'node:os';
import { executeCommand } from './executor.js';
import { logger } from '../utils/logger.js';
const PS_BASE = 'powershell -NoProfile -NonInteractive -Command ';
export async function listServices(filter, limit = 50) {
    if (os.platform() === 'win32') {
        const ps = PS_BASE +
            '"Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json -Compress"';
        const r = await executeCommand(ps, { timeout: 30000 });
        if (r.exitCode !== 0)
            throw new Error(r.stderr.substring(0, 200));
        const raw = JSON.parse(r.stdout);
        const rows = Array.isArray(raw) ? raw : [raw];
        let services = rows.map((s) => ({
            name: s.Name,
            displayName: s.DisplayName,
            status: String(s.Status),
        }));
        if (filter) {
            const needle = filter.toLowerCase();
            services = services.filter((s) => s.name.toLowerCase().includes(needle) || s.displayName.toLowerCase().includes(needle));
        }
        return services.slice(0, limit);
    }
    // POSIX: systemctl, parse "UNIT LOAD ACTIVE SUB DESCRIPTION"
    const r = await executeCommand('systemctl list-units --type=service --no-pager --plain', { timeout: 15000 });
    if (r.exitCode !== 0)
        throw new Error(r.stderr.substring(0, 200));
    let services = [];
    for (const line of r.stdout.split('\n')) {
        const m = line.trim().match(/^(\S+\.service)\s+\S+\s+(\S+)\s+\S+\s+(.*)$/);
        if (!m)
            continue;
        services.push({ name: m[1], displayName: m[3] || m[1], status: m[2] });
    }
    if (filter) {
        const needle = filter.toLowerCase();
        services = services.filter((s) => s.name.toLowerCase().includes(needle) || s.displayName.toLowerCase().includes(needle));
    }
    return services.slice(0, limit);
}
export async function executeServiceAction(action, name) {
    // Service names go into a command line — reject anything shell-meaningful
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        throw new Error(`Invalid service name: ${name}`);
    }
    const cmd = os.platform() === 'win32'
        ? `${PS_BASE} "${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Restart'}-Service -Name '${name}' -ErrorAction Stop; Write-Output OK"`
        : `systemctl ${action} ${name}`;
    const r = await executeCommand(cmd, { timeout: 30000 });
    if (r.exitCode !== 0 || (os.platform() === 'win32' && !r.stdout.includes('OK'))) {
        throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).substring(0, 300) +
            ' (service control usually requires an elevated process)');
    }
    logger.info('Service action completed', { action, name });
    return `Service ${name}: ${action} OK`;
}
//# sourceMappingURL=service-actions.js.map