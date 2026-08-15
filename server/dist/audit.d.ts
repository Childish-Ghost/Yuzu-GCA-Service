export interface AuditEntry {
    ts: number;
    deviceId: string;
    action: string;
    detail: string;
    status: string;
}
export declare function pushEntry(entry: AuditEntry): void;
export declare function query(limit: number, deviceId?: string): {
    entries: AuditEntry[];
    count: number;
};
