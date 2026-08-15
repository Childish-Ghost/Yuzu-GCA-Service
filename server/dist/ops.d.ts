export interface PendingOp {
    id: string;
    device: string;
    operation: string;
    detail: string;
    code: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    createdAt: number;
    deviceIp?: string;
    machineId?: string;
    devicePort?: number;
    /** 设备自铸 token——审批通过后写入注册表（S1） */
    deviceToken?: string;
    /** 飞书卡片消息 id（审批后回写状态用，2026-08-14） */
    cardMessageId?: string;
}
/** op → 公开事件形态（SSE/列表用，不含 code） */
declare function toPublicOp(op: PendingOp): {
    id: string;
    device: string;
    operation: string;
    status: "approved" | "expired" | "pending" | "rejected";
    detail: string;
    createdAt: number;
    deviceIp: string | undefined;
};
/** 校验卡片回调签名 + senderId 是 owner */
export declare function verifyCardAction(opId: string, signature: string, senderId: string): boolean;
/** 审批后回写卡片状态 */
export declare function updateApprovalCard(op: PendingOp, status: string): Promise<void>;
export declare function createOpRequest(device: string, operation: string, detail: string, deviceIp?: string, machineId?: string, devicePort?: number, deviceToken?: string): {
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
/** 按确认码查找 op（卡片回写用——rejectOp 返回 boolean 后按 code 定位） */
export declare function getOpByCode(code: string): PendingOp | undefined;
/** 按 id 审批（App/卡片回调通道，2026-08-14）——device_registration 副作用由调用方处理 */
export declare function approveOpById(id: string): {
    ok: boolean;
    op?: PendingOp;
    error?: string;
};
export declare function rejectOpById(id: string): {
    ok: boolean;
    op?: PendingOp;
    error?: string;
};
/** 待审批列表（App 轮询/SSE snapshot/面板，不含 code） */
export declare function listOps(status?: string): ReturnType<typeof toPublicOp>[];
export declare function getOpStatus(id: string): PendingOp | undefined;
/** 公开状态（轮询用）——不含 code（M6 修复：确认码只走 owner 通道） */
export declare function getOpStatusPublic(id: string): {
    id: string;
    device: string;
    operation: string;
    status: string;
    detail?: string;
    createdAt: number;
} | undefined;
export declare function registerPendingDevice(name: string, token: string): void;
export declare function pendingDeviceNameByToken(token: string): string | null;
export declare function clearPendingDevice(name: string): void;
export declare function sweepOps(): number;
export {};
