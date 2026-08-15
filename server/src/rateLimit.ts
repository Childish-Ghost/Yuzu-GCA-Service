/**
 * rateLimit.ts — 内存滑动窗口限速（2026-08-12 审查 S6 修复）。
 *
 * 无速率限制的风险：/pair/claim、/ops/approve、/register 可被局域网内
 * 任意主机无限尝试——6 位十进制确认码仅 90 万组合可暴力。
 *
 * 档位（宽松阈值 + 依赖错 5 次烧码机制，避免误伤合法操作）：
 *   /pair/init     30/小时/IP    配对码铸造（owner）
 *   /pair/claim    10/分钟/IP    配对码消耗（新设备）
 *   /ops/approve   60/分钟/IP + 全局 300/分钟
 *   /register      10/小时/IP    注册审批请求
 */
import http from 'node:http';

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  allow(key: string, limit: number): boolean {
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

  sweep(now: number = Date.now()): void {
    for (const [k, v] of this.hits) {
      if (v.length === 0 || now - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
    }
  }
}

export const pairClaimLimiter = new RateLimiter(60_000);
export const pairInitLimiter = new RateLimiter(3600_000);
export const approveLimiter = new RateLimiter(60_000);
export const approveGlobalLimiter = new RateLimiter(60_000);
export const registerLimiter = new RateLimiter(3600_000);

export function clientIp(req: http.IncomingMessage): string {
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
