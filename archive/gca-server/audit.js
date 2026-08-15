/**
 * Audit log — in-memory ring buffer, 1000 entries.
 */
const AUDIT_MAX = 1000;
const log = [];
export function pushEntry(entry) {
    log.push(entry);
    if (log.length > AUDIT_MAX)
        log.shift();
}
export function query(limit, deviceId) {
    let entries = log;
    if (deviceId)
        entries = entries.filter(e => e.deviceId === deviceId);
    return { entries: entries.slice(-limit), count: entries.length };
}
//# sourceMappingURL=audit.js.map