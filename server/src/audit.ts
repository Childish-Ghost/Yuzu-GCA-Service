/**
 * Audit log — in-memory ring buffer, 1000 entries.
 */
const AUDIT_MAX = 1000;

export interface AuditEntry {
  ts: number;
  deviceId: string;
  action: string;
  detail: string;
  status: string;
}

const log: AuditEntry[] = [];

export function pushEntry(entry: AuditEntry): void {
  log.push(entry);
  if (log.length > AUDIT_MAX) log.shift();
}

export function query(limit: number, deviceId?: string): { entries: AuditEntry[]; count: number } {
  let entries = log;
  if (deviceId) entries = entries.filter(e => e.deviceId === deviceId);
  return { entries: entries.slice(-limit), count: entries.length };
}