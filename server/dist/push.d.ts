export interface PushTarget {
    channel: string;
    target: string;
}
/** owner 通道目标（App 卡片回调用同一 allowlist 校验 senderId） */
export declare const OWNER_FEISHU_OPEN_ID = "ou_9e2a60ba69101ee35caaccfcb9f14cd1";
/** 从 openclaw.json / credentials 读飞书凭据 */
export declare function loadLarkCreds(): {
    appId: string;
    appSecret: string;
} | null;
/** 发飞书交互卡片消息（receive_id_type=open_id） */
export declare function sendFeishuCard(card: unknown, target?: string): Promise<{
    ok: boolean;
    detail: string;
    messageId?: string;
}>;
/** 更新已发送卡片（审批后回写状态；卡片需 config.update_multi）。
 * 与 lark 插件 updateCardFeishu 完全一致：PATCH 只传 content（不带 msg_type——
 * 带 msg_type 会被飞书当作新消息处理，无法原地更新原卡片）。 */
export declare function updateFeishuCard(messageId: string, card: unknown): Promise<{
    ok: boolean;
    detail: string;
}>;
export declare function push(text: string): Promise<{
    accepted: boolean;
    channels: string[];
}>;
