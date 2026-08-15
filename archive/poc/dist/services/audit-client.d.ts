/**
 * Audit Client (INT-003) — pushes operation logs to the gap-relay.
 *
 * Devices call audit() after confirmed operations so the server has a
 * centralized view of who-did-what-when across the fleet.
 */
export interface AuditEntry {
    deviceId: string;
    action: string;
    detail?: string;
    status?: string;
}
export declare function audit(entry: AuditEntry): Promise<void>;
