/**
 * Audit Client (INT-003/INT-005) — pushes operation logs to gca-server.
 *
 * Devices call audit() after confirmed operations so the server has a
 * centralized view of who-did-what-when across the fleet.
 *
 * INT-005（审计集中）：开关 `GCA_AUDIT_PUSH=1`（默认关——本地留痕为默认）；
 * 服务器地址优先 GCA_SERVER_URL（desktop/宿主注入），回退 GAP_RELAY_URL / config.gap.relayUrl。
 * 挂钩点：exec 执行/拦截、confirm 审批通过、票据直下传输。
 */
export interface AuditEntry {
    /** 缺省时用 config.deviceName */
    deviceId?: string;
    action: string;
    detail?: string;
    status?: string;
}
export declare function audit(entry: AuditEntry): Promise<void>;
