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
export declare class RateLimiter {
    private readonly windowMs;
    private hits;
    constructor(windowMs: number);
    allow(key: string, limit: number): boolean;
    sweep(now?: number): void;
}
export declare const pairClaimLimiter: RateLimiter;
export declare const pairInitLimiter: RateLimiter;
export declare const approveLimiter: RateLimiter;
export declare const approveGlobalLimiter: RateLimiter;
export declare const registerLimiter: RateLimiter;
export declare function clientIp(req: http.IncomingMessage): string;
