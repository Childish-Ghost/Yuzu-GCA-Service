/**
 * 审批事件流（2026-08-14）：GET /ops/events 的 SSE 数据源——App 审批下发通道。
 * 连接即发 snapshot（全部 pending），之后实时推送 op.created / op.resolved。
 * 复用 events.ts 的 SSE 模式（Node http 手写，零依赖）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
interface OpEvent {
    id: string;
    device: string;
    operation: string;
    status: string;
    detail?: string;
    createdAt: number;
}
type Listener = (ev: OpEvent) => void;
/** 订阅（SSE 连接建立时）；返回取消函数 */
export declare function subscribe(fn: Listener): () => void;
/** 广播 op 事件（created/resolved） */
export declare function emitOpEvent(ev: OpEvent): void;
/** SSE 连接处理：立即发 snapshot（当前全部 pending），再转发实时事件 */
export declare function handleOpsEvents(req: IncomingMessage, res: ServerResponse, listPending: () => OpEvent[]): void;
export {};
