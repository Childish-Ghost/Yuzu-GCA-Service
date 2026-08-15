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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transferBaseUrl } from './transfer-host.js';
/** 下载大小上限（与 rust file_transfer.rs 一致） */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
/**
 * Matches the one-shot transfer URL shape produced by file_serve.
 * **host 必须为本机**（transferBaseUrl 探测结果或 127.0.0.1）——
 * 与 rust is_ticket_url 语义一致：本机基址（含端口）、127.0.0.1、
 * 或端口无关的主机名匹配。
 */
export async function isTransferTicketUrl(url) {
    const m = /^http:\/\/([\w.:-]+)\/transfer\/([\w-]{20,})$/i.exec(url);
    if (!m)
        return false;
    const host = m[1];
    if (!host)
        return false;
    const base = await transferBaseUrl();
    const baseHost = base.replace(/^https?:\/\//, '').split('/')[0] ?? '';
    const hostNoPort = host.split(':')[0] ?? '';
    const baseNoPort = baseHost.split(':')[0] ?? '';
    return (host.toLowerCase() === baseHost.toLowerCase() ||
        host.toLowerCase() === '127.0.0.1' ||
        (!!hostNoPort && !!baseNoPort && hostNoPort.toLowerCase() === baseNoPort.toLowerCase()));
}
export async function downloadFile(url, targetPath) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
        throw new Error(`Source returned HTTP ${res.status} (ticket invalid, expired, or already used)`);
    }
    const expected = Number(res.headers.get('content-length') ?? -1);
    if (expected > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File too large: ${expected} bytes (max ${MAX_DOWNLOAD_BYTES})`);
    }
    // 流式读取 + 总量上限（C5：此前全量入内存）
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
            throw new Error(`File too large: exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
        }
        chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    if (expected >= 0 && buf.length !== expected) {
        throw new Error(`Size mismatch: expected ${expected} bytes, got ${buf.length} (transfer truncated)`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, buf);
    return { bytes: buf.length, sizeMatches: expected < 0 || buf.length === expected };
}
//# sourceMappingURL=transfer-fetch.js.map