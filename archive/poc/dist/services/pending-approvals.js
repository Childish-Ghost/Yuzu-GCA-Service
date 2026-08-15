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
import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
const MAX_NONCE_ATTEMPTS = 3;
// Unambiguous alphabet: no 0/O, 1/I/L — tokens are read and retyped by humans
const TOKEN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_LENGTH = 6;
const DEFAULT_TTL_MS = config.approval.ttlMs;
const MAX_PENDING = 100;
const pending = new Map();
function mintToken() {
    let token = '';
    for (let i = 0; i < TOKEN_LENGTH; i++) {
        token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
    }
    return token;
}
function isExpired(entry, ttlMs) {
    return Date.now() - entry.createdAt > ttlMs;
}
function describeOperation(op) {
    switch (op.kind) {
        case 'exec':
            return op.command.substring(0, 100);
        case 'file_write':
            return `${op.mode} ${op.path} (${op.content.length} chars)`;
        case 'file_move':
            return `${op.source} -> ${op.dest}`;
        case 'file_delete':
            return `${op.recursive ? 'recursive ' : ''}${op.path}`;
        case 'file_serve':
            return op.path;
        case 'file_fetch':
            return `${op.url} -> ${op.targetPath}`;
        case 'screenshot':
            return `quality=${op.quality} ocr=${op.ocr}`;
        case 'remote_input':
            return `${op.inputAction.type}`;
        case 'clipboard_sync':
            return `${op.action}`;
        case 'input_consent':
            return `${op.minutes}min window`;
        case 'screen_consent':
            return `${op.minutes}min window`;
        case 'power':
            return `${op.action}${op.delaySec ? ` delay=${op.delaySec}s` : ''}${op.mac ? ` mac=${op.mac}` : ''}`;
        case 'service':
            return `${op.action} ${op.name}`;
    }
}
/**
 * Stores an operation awaiting confirmation and returns its token
 * (plus a push nonce for high-risk kinds).
 * Evicts the oldest entries if the store exceeds MAX_PENDING.
 */
export function createPending(input, ttlMs = DEFAULT_TTL_MS) {
    if (pending.size >= MAX_PENDING) {
        // Evict expired entries first; if none expired, evict the oldest
        let evicted = 0;
        for (const [token, entry] of pending) {
            if (isExpired(entry, ttlMs) || evicted > 0 || pending.size > MAX_PENDING) {
                pending.delete(token);
                evicted++;
            }
        }
    }
    let token = mintToken();
    while (pending.has(token)) {
        token = mintToken();
    }
    const isHighRisk = input.operation.kind === 'power' || input.operation.kind === 'service';
    const nonce = isHighRisk ? String(randomInt(1000)).padStart(3, '0') : undefined;
    pending.set(token, {
        operation: input.operation,
        reason: input.reason,
        createdAt: Date.now(),
        nonce,
        attempts: 0,
    });
    logger.info('Pending approval created', {
        token,
        kind: input.operation.kind,
        detail: describeOperation(input.operation),
        hasNonce: nonce !== undefined,
        ttlMs,
    });
    return { token, nonce };
}
/**
 * Returns and removes the pending operation for a token (single-use).
 * Returns null if the token is unknown, expired, or already consumed.
 */
export function consumePending(token, ttlMs = DEFAULT_TTL_MS) {
    const entry = pending.get(token);
    if (!entry) {
        logger.warn('confirm with unknown token', { token });
        return null;
    }
    pending.delete(token);
    if (isExpired(entry, ttlMs)) {
        logger.warn('confirm with expired token', { token, ageMs: Date.now() - entry.createdAt });
        return null;
    }
    return entry;
}
/**
 * Consumes the NEWEST unexpired pending matching `kinds` and `filter`
 * (used by the TOTP flow and the bare-confirm flow).
 */
export function consumeLatestOfKinds(kinds, filter, ttlMs = DEFAULT_TTL_MS) {
    let newestToken = null;
    let newest = null;
    for (const [token, entry] of pending) {
        if (!kinds.includes(entry.operation.kind))
            continue;
        if (filter && !filter(entry.operation))
            continue;
        if (isExpired(entry, ttlMs))
            continue;
        if (!newest || entry.createdAt > newest.createdAt) {
            newest = entry;
            newestToken = token;
        }
    }
    if (!newestToken)
        return null;
    pending.delete(newestToken);
    return newest;
}
/**
 * Validates a push nonce against high-risk pendings (GAP-v2).
 * A match consumes the op. Wrong guesses increment attempts on every
 * pending high-risk op; an op is burned after MAX_NONCE_ATTEMPTS misses.
 */
export function validateOtpNonce(code, ttlMs = DEFAULT_TTL_MS) {
    for (const [token, entry] of pending) {
        if (!entry.nonce || isExpired(entry, ttlMs))
            continue;
        if (entry.nonce === code) {
            pending.delete(token);
            return entry;
        }
    }
    for (const [token, entry] of pending) {
        if (!entry.nonce || isExpired(entry, ttlMs))
            continue;
        entry.attempts++;
        if (entry.attempts >= MAX_NONCE_ATTEMPTS) {
            pending.delete(token);
            logger.warn('pending op burned after repeated wrong nonces', {
                kind: entry.operation.kind,
                attempts: entry.attempts,
            });
        }
    }
    return null;
}
/** Visible for testing — removes all pending entries. */
export function clearPending() {
    pending.clear();
}
//# sourceMappingURL=pending-approvals.js.map