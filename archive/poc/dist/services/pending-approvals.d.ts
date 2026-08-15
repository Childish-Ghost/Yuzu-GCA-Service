/**
 * Pending Approvals Store - holds operations waiting for user confirmation.
 *
 * Flow:
 *   1. A write operation (exec command, file_write, file_move) is submitted
 *      → createPending() mints a short token
 *   2. The agent relays the token to the user via the chat channel
 *   3. User confirms → agent calls the confirm tool with the token
 *      → consumePending() returns the stored operation (single-use)
 *      → the confirm tool dispatches by operation kind and executes
 *
 * Tokens are single-use and expire after TTL (default 5 minutes).
 * The store is a module-level singleton on purpose: the confirmation arrives
 * on a later agent turn, possibly over a different MCP connection.
 */
import type { PowerAction } from '../types/tools.js';
export type PendingOperation = {
    kind: 'exec';
    command: string;
    cwd?: string;
    timeout?: number;
    background?: boolean;
} | {
    kind: 'file_write';
    path: string;
    content: string;
    mode: 'overwrite' | 'append';
    createDirs: boolean;
} | {
    kind: 'file_move';
    source: string;
    dest: string;
} | {
    kind: 'file_delete';
    path: string;
    recursive: boolean;
} | {
    kind: 'file_serve';
    path: string;
} | {
    kind: 'file_fetch';
    url: string;
    targetPath: string;
} | {
    kind: 'screenshot';
    quality: number;
    ocr: boolean;
} | {
    kind: 'screen_consent';
    minutes: number;
} | {
    kind: 'remote_input';
    inputAction: import('./input-simulator.js').InputAction;
} | {
    kind: 'input_consent';
    minutes: number;
} | {
    kind: 'clipboard_sync';
    action: 'get' | 'set';
    text: string;
} | {
    kind: 'power';
    action: PowerAction;
    delaySec?: number;
    mac?: string;
} | {
    kind: 'service';
    action: 'start' | 'stop' | 'restart';
    name: string;
};
export interface PendingApproval {
    operation: PendingOperation;
    reason: string;
    createdAt: number;
    /** 3-digit push nonce for high-risk ops (power/service) — the number the
     *  owner replies with after reading the out-of-band approval push. */
    nonce?: string;
    /** Failed nonce guesses so far; op is burned at MAX_NONCE_ATTEMPTS. */
    attempts: number;
}
export interface CreatedPending {
    token: string;
    nonce?: string;
}
/**
 * Stores an operation awaiting confirmation and returns its token
 * (plus a push nonce for high-risk kinds).
 * Evicts the oldest entries if the store exceeds MAX_PENDING.
 */
export declare function createPending(input: {
    operation: PendingOperation;
    reason: string;
}, ttlMs?: number): CreatedPending;
/**
 * Returns and removes the pending operation for a token (single-use).
 * Returns null if the token is unknown, expired, or already consumed.
 */
export declare function consumePending(token: string, ttlMs?: number): PendingApproval | null;
/**
 * Consumes the NEWEST unexpired pending matching `kinds` and `filter`
 * (used by the TOTP flow and the bare-confirm flow).
 */
export declare function consumeLatestOfKinds(kinds: PendingOperation['kind'][], filter?: (op: PendingOperation) => boolean, ttlMs?: number): PendingApproval | null;
/**
 * Validates a push nonce against high-risk pendings (GAP-v2).
 * A match consumes the op. Wrong guesses increment attempts on every
 * pending high-risk op; an op is burned after MAX_NONCE_ATTEMPTS misses.
 */
export declare function validateOtpNonce(code: string, ttlMs?: number): PendingApproval | null;
/** Visible for testing — removes all pending entries. */
export declare function clearPending(): void;
