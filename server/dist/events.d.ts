/**
 * events.ts — 设备状态集中探测 + /events SSE 广播（事件驱动设备状态，阶段一步骤 1）
 *
 * 职责：gca-server 成为设备状态的单一事实源——
 *   1. 周期探测每台设备 agent /health 与 term（端口+10）/health
 *   2. 状态变化经 SSE 广播（snapshot + 增量事件），desktop 订阅免轮询
 * 协议见 docs/event-driven-plan.md；端点文档见 docs/api.md
 *
 * 事件格式（SSE，event/data 帧，空行分隔）：
 *   event: snapshot        data: {"devices":[{device,url,agent,term}...]}   连接即发全量
 *   event: device.online   data: {device,url,agent,term}                    任一服务恢复在线
 *   event: device.offline  data: {device,url,agent,term}                    全部已声明服务离线
 *   event: device.updated  data: {device,url,agent,term}                    URL 变动/uptime 校准
 *   event: device.removed  data: {"device":name}                            注册表移除（revoke）
 *
 * 广播纪律：只发状态变化 + 每 6 轮（60s）低频校准一次——不逐轮广播防事件风暴。
 * 探测防抖：连续 failThreshold 次失败才判离线（单次超时不误报）；1 次成功即在线。
 */
export interface ServiceStatus {
    online: boolean;
    uptime: number;
    /** epoch 秒——客户端用于本地跳动校准（uptime_base/probed_at 机制） */
    probed_at: number;
    fail_count: number;
}
export interface DeviceStatus {
    name: string;
    /** agent 端点（注册表 URL，形如 http://ip:3001/mcp） */
    url: string;
    agent: ServiceStatus;
    term: ServiceStatus;
}
export interface EventServiceDeps {
    listDevices: () => Promise<Array<{
        name: string;
        url: string;
    }>>;
    fetchImpl: typeof fetch;
    /** 探测周期 ms */
    probeIntervalMs?: number;
    /** 单次探测超时 ms */
    healthTimeoutMs?: number;
    /** 连续失败次数达到才判离线 */
    failThreshold?: number;
    log?: (...args: unknown[]) => void;
}
export interface EventService {
    /** /events SSE 端点处理器（调用方需先过 Bearer auth；返回 snapshot 写毕时 resolve——路由可不 await） */
    handleEvents(req: {
        on(ev: string, fn: () => void): unknown;
    }, res: {
        writeHead(code: number, headers: Record<string, string>): unknown;
        write(chunk: string): unknown;
        on(ev: string, fn: () => void): unknown;
        end(): unknown;
    }): Promise<void>;
    /** /heartbeat URL 更新 → 立即广播 device.updated */
    notifyHeartbeat(name: string, newUrl: string): void;
    /** /revoke → 立即移除并广播 device.removed */
    notifyRemoved(name: string): void;
    /** 启动探测循环（幂等；createEventService 不自动启动——测试可控） */
    start(): void;
    /** 立即跑一轮探测（测试/手动触发用） */
    probeNow(): Promise<void>;
    /** 停止探测循环并断开所有订阅者 */
    close(): void;
}
export declare function createEventService(deps: EventServiceDeps): EventService;
