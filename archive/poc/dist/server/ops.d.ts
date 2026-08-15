interface PendingOp {
    id: string;
    device: string;
    operation: string;
    detail: string;
    code: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    createdAt: number;
    deviceIp?: string;
}
export declare function createOpRequest(device: string, operation: string, detail: string, deviceIp?: string): {
    id: string;
    code: string;
    expiresInSec: number;
};
export declare function approveOp(code: string): {
    ok: boolean;
    op?: PendingOp;
    error?: string;
};
export declare function rejectOp(code: string): boolean;
export declare function getOpStatus(id: string): PendingOp | undefined;
/** Cleanup expired ops (call periodically) */
export declare function sweepOps(): number;
export {};
