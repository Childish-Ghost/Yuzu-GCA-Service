export class RateLimiter {
    windowMs;
    hits = new Map();
    constructor(windowMs) {
        this.windowMs = windowMs;
    }
    allow(key, limit) {
        const now = Date.now();
        const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (arr.length >= limit) {
            this.hits.set(key, arr);
            return false;
        }
        arr.push(now);
        this.hits.set(key, arr);
        return true;
    }
    sweep(now = Date.now()) {
        for (const [k, v] of this.hits) {
            if (v.length === 0 || now - v[v.length - 1] >= this.windowMs)
                this.hits.delete(k);
        }
    }
}
export const pairClaimLimiter = new RateLimiter(60_000);
export const pairInitLimiter = new RateLimiter(3600_000);
export const approveLimiter = new RateLimiter(60_000);
export const approveGlobalLimiter = new RateLimiter(60_000);
export const registerLimiter = new RateLimiter(3600_000);
export function clientIp(req) {
    return (req.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
}
const sweepTimer = setInterval(() => {
    pairClaimLimiter.sweep();
    pairInitLimiter.sweep();
    approveLimiter.sweep();
    approveGlobalLimiter.sweep();
    registerLimiter.sweep();
}, 60_000);
sweepTimer.unref();
//# sourceMappingURL=rateLimit.js.map