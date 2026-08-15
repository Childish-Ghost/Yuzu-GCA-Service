/**
 * Transfer Fetch - the download half of cross-device transfer.
 *
 * Shared by the file_fetch tool (ticket URLs execute immediately) and the
 * confirm dispatcher (foreign URLs run after confirmation).
 *
 * C2/C5 修复（2026-08-12 审查，与 agent/src/tools/file_transfer.rs 对齐）：
 *   - isTransferTicketUrl 增加**本机 host 校验**——纯形状匹配会让任意主机
 *     /transfer/<20+字符> 免确认写盘（审批绕过）
 *   - downloadFile 流式读取 + 512MB 上限（此前 res.arrayBuffer() 全量入内存且无上限）
 */
/**
 * Matches the one-shot transfer URL shape produced by file_serve.
 * **host 必须为本机**（transferBaseUrl 探测结果或 127.0.0.1）——
 * 与 rust is_ticket_url 语义一致：本机基址（含端口）、127.0.0.1、
 * 或端口无关的主机名匹配。
 */
export declare function isTransferTicketUrl(url: string): Promise<boolean>;
export interface FetchOutcome {
    bytes: number;
    sizeMatches: boolean;
}
export declare function downloadFile(url: string, targetPath: string): Promise<FetchOutcome>;
