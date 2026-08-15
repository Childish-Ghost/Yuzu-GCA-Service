/**
 * Shared MCP tool type definitions (S-001).
 *
 * Single source of truth for:
 *   - the tool registry (names)
 *   - the wire result shape of every tool — result bodies are serialized
 *     as JSON inside MCP text content, and these interfaces are what the
 *     gateway / LLM actually parses
 *
 * Phase 1 covers the 4 implemented tools. Phase 2 adds its 10 tools here
 * BEFORE their handlers are written (type-first).
 */
export declare const TOOL_NAMES: readonly ["exec", "confirm", "file_list", "file_read", "file_write", "file_move", "file_delete", "exec_background", "process_list", "power", "service", "notify_send", "sysinfo"];
export type ToolName = (typeof TOOL_NAMES)[number];
export interface ExecExecutedResult {
    status: 'executed';
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
    stdout: string;
    stderr: string;
}
export interface ExecConfirmationRequiredResult {
    status: 'confirmation_required';
    command: string;
    reason: string;
    executed: false;
    expiresInSec: number;
    note: string;
}
export interface ExecBlockedResult {
    status: 'blocked';
    command: string;
    reason: string;
    executed: false;
}
export interface ExecErrorResult {
    status: 'error';
    command: string;
    error: string;
    executed: false;
}
export type ExecToolResult = ExecExecutedResult | ExecConfirmationRequiredResult | ExecBlockedResult | ExecErrorResult;
export interface ExecConfirmExecutedResult extends ExecExecutedResult {
    confirmedByUser: true;
}
export interface ConfirmFailedResult {
    status: 'confirm_failed';
    token: string;
    executed: false;
    reason: string;
}
export type ConfirmToolResult = ExecConfirmExecutedResult | FileWriteOkResult | FileMoveOkResult | ConfirmFailedResult | ExecBlockedResult | ExecErrorResult;
export interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    mtime?: string;
}
export interface FileListOkResult {
    status: 'ok';
    path: string;
    pattern: string | null;
    recursive: boolean;
    truncated: boolean;
    totalEntries: number;
    entries: FileEntry[];
}
export interface FileListErrorResult {
    status: 'error';
    path: string;
    error: string;
}
export type FileListToolResult = FileListOkResult | FileListErrorResult;
export interface FileReadOkResult {
    status: 'ok';
    path: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    truncated: boolean;
    content: string;
}
export interface FileReadErrorResult {
    status: 'error';
    path: string;
    error: string;
}
export type FileReadToolResult = FileReadOkResult | FileReadErrorResult;
export interface FileWriteOkResult {
    status: 'written';
    path: string;
    bytes: number;
    mode: 'overwrite' | 'append';
    confirmedByUser?: true;
}
export type FileWriteToolResult = FileWriteOkResult | WriteOpConfirmationRequiredResult | FileWriteErrorResult;
export interface FileWriteErrorResult {
    status: 'error';
    path: string;
    error: string;
}
export interface FileMoveOkResult {
    status: 'moved';
    source: string;
    dest: string;
    confirmedByUser?: true;
}
export interface FileMoveErrorResult {
    status: 'error';
    source: string;
    dest: string;
    error: string;
}
export type FileMoveToolResult = FileMoveOkResult | WriteOpConfirmationRequiredResult | FileMoveErrorResult;
export type WriteOperationKind = 'exec' | 'exec_background' | 'file_write' | 'file_move' | 'file_delete' | 'file_serve' | 'file_fetch' | 'power' | 'service';
export interface WriteOpConfirmationRequiredResult {
    status: 'confirmation_required';
    operation: WriteOperationKind;
    reason: string;
    executed: false;
    expiresInSec: number;
    note: string;
}
/**
 * High-risk operations (power / service): the confirmation code reaches the
 * AI through NO channel it can read:
 *   - 'push'         → approval push sent via gap-relay (Feishu/WeChat), owner
 *                      replies with the nonce shown in the push
 *   - 'authenticator' → user types the current TOTP code from their app
 *   - 'desktop'      → code popped on the device screen (fallback)
 *   - 'server-log'   → code in the server log (last resort)
 * The code itself is never included in this response.
 */
export interface OtpConfirmationRequiredResult {
    status: 'confirmation_required';
    operation: 'power' | 'service';
    delivery: 'push' | 'authenticator' | 'desktop' | 'server-log';
    reason: string;
    executed: false;
    expiresInSec: number;
    note: string;
}
export interface FileDeleteOkResult {
    status: 'deleted';
    path: string;
    recursive: boolean;
    confirmedByUser?: true;
}
export interface FileDeleteErrorResult {
    status: 'error';
    path: string;
    error: string;
}
export type FileDeleteToolResult = FileDeleteOkResult | WriteOpConfirmationRequiredResult | FileDeleteErrorResult;
export interface ExecBackgroundStartedResult {
    status: 'started';
    taskId: string;
    pid: number;
    command: string;
    logPath: string;
    confirmedByUser?: true;
}
export interface ExecBackgroundErrorResult {
    status: 'error';
    command: string;
    error: string;
}
export type ExecBackgroundToolResult = ExecBackgroundStartedResult | WriteOpConfirmationRequiredResult | ExecBlockedResult | ExecBackgroundErrorResult;
export type PowerAction = 'shutdown' | 'restart' | 'sleep' | 'hibernate' | 'wol' | 'abort';
export interface PowerOkResult {
    status: 'ok';
    action: PowerAction;
    detail: string;
    confirmedByUser?: true;
}
export interface PowerErrorResult {
    status: 'error';
    action: PowerAction;
    error: string;
}
export type PowerToolResult = PowerOkResult | OtpConfirmationRequiredResult | WriteOpConfirmationRequiredResult | PowerErrorResult;
export interface ServiceInfo {
    name: string;
    displayName: string;
    status: string;
}
export interface ServiceListOkResult {
    status: 'ok';
    total: number;
    returned: number;
    services: ServiceInfo[];
}
export interface ServiceActionOkResult {
    status: 'ok';
    action: 'start' | 'stop' | 'restart';
    name: string;
    confirmedByUser?: true;
}
export interface ServiceErrorResult {
    status: 'error';
    error: string;
}
export type ServiceToolResult = ServiceListOkResult | ServiceActionOkResult | OtpConfirmationRequiredResult | ServiceErrorResult;
export interface NotifySendOkResult {
    status: 'sent';
    channel: 'msg.exe' | 'server-log';
    title: string;
}
export type NotifySendToolResult = NotifySendOkResult;
export interface ProcessInfo {
    pid: number;
    name: string;
    cpuSec: number | null;
    memoryMB: number;
}
export interface ProcessListOkResult {
    status: 'ok';
    total: number;
    returned: number;
    sortBy: 'cpu' | 'memory' | 'pid' | 'name';
    processes: ProcessInfo[];
}
export interface ProcessListErrorResult {
    status: 'error';
    error: string;
}
export type ProcessListToolResult = ProcessListOkResult | ProcessListErrorResult;
export interface FileServeOkResult {
    status: 'serving';
    path: string;
    size: number;
    url: string;
    expiresInSec: number;
    confirmedByUser?: true;
}
export interface FileFetchOkResult {
    status: 'fetched';
    url: string;
    targetPath: string;
    bytes: number;
    sizeMatches: boolean;
    confirmedByUser?: true;
}
export interface FileTransferErrorResult {
    status: 'error';
    error: string;
}
export type FileServeToolResult = FileServeOkResult | WriteOpConfirmationRequiredResult | FileTransferErrorResult;
export type FileFetchToolResult = FileFetchOkResult | WriteOpConfirmationRequiredResult | FileTransferErrorResult;
export interface SysinfoOkResult {
    status: 'ok';
    hostname: string;
    os: {
        platform: string;
        type: string;
        release: string;
        arch: string;
        uptimeHours: number;
    };
    cpu: {
        model: string;
        cores: number;
        speedMHz: number | null;
        loadAvg: number[];
        loadAvgNote: string | null;
    };
    memory: {
        totalMB: number;
        freeMB: number;
        usedMB: number;
        usedPercent: number;
    };
    disk: {
        path: string;
        totalGB: number;
        freeGB: number;
        usedPercent: number | null;
    } | {
        error: string;
    };
    network: {
        name: string;
        address: string;
        mac: string;
    }[];
    collectedAt: string;
}
