/**
 * mdns.ts — 局域网服务发现发布端（INT-004）：DNS-SD 服务 _gca-server._tcp.local.
 *
 * 让 desktop / agent 通过 mDNS 自动发现 gca-server（替代手填地址 / 全网段端口扫描）。
 * 零依赖：node:dgram + 手写 DNS 包编解码（组播 224.0.0.251:5353）。
 *
 * 行为：
 *   1. 启动即发一次 announce（PTR + SRV + TXT + A，多播，TTL 120s）
 *   2. 应答 `_gca-server._tcp.local.` 的 PTR 查询（多播应答，同包带附加节）
 *   3. 每 60s 重新 announce（防缓存过期）
 *
 * 客户端解析约定（desktop mdns.rs / 本模块自测）：
 *   服务器地址 = 应答包源 IP + SRV rdata 端口（A 记录供标准 mDNS 工具使用）。
 * 绑定失败（端口被占等）→ 静默降级，不影响服务本身。
 */
/** DNS-SD 服务类型（标准后缀 .local.） */
export declare const SERVICE_TYPE = "_gca-server._tcp.local.";
/** 服务实例名（PTR 指向它） */
export declare const INSTANCE: string;
/** SRV 目标主机名（A 记录挂它；客户端实际用源 IP） */
export declare const TARGET = "gca-server.local.";
export interface MdnsOptions {
    /** gca-server 端口（SRV rdata 用） */
    port: number;
    /** TXT 附加信息（如 version） */
    info?: Record<string, string>;
    /** 日志（默认静默） */
    log?: (...args: unknown[]) => void;
}
export interface MdnsAnnouncer {
    close(): void;
}
/** 组装多播应答包（复制请求 ID；QD=0，AN=PTR/SRV/TXT，AR=A×N） */
export declare function buildResponse(id: number, port: number, info: Record<string, string>, ips: string[]): Buffer;
/** 仅应答 _gca-server._tcp.local. 的 PTR/ANY 查询（标准查询，非响应）。
 *  `unicast`：QU 位（QCLASS 高比特）——客户端用临时端口收不到组播应答，按规范改单播回包。 */
export declare function shouldRespond(pkt: Buffer): {
    id: number;
    ok: boolean;
    unicast: boolean;
};
/**
 * 启动 mDNS 发布。绑定失败（5353 被占）→ log 后返回可 close 的空对象（优雅降级）。
 */
export declare function startMdnsAnnouncer(opts: MdnsOptions): MdnsAnnouncer;
