/**
 * Constant-time string comparison — shared auth primitive.
 *
 * Used by gca-server (owner token), mcp.ts, devices.ts (device token),
 * ops.ts (pending device token). Single place so every token check
 * gets timing-safe semantics (2026-08-11/12 审查：mcp.ts 曾用明文 ===）。
 */
import { timingSafeEqual } from 'node:crypto';
export function tokenEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
//# sourceMappingURL=consttime.js.map