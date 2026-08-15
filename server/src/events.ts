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

interface ProbeResult {
  ok: boolean;
  uptime: number;
}

export interface EventServiceDeps {
  listDevices: () => Promise<Array<{ name: string; url: string }>>;
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
  handleEvents(req: { on(ev: string, fn: () => void): unknown }, res: {
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

function fresh(): ServiceStatus {
  return { online: false, uptime: 0, probed_at: 0, fail_count: 0 };
}

/** agent 的 /health URL；portOffset=10 时切到 term（端口 +10 约定） */
function healthUrl(base: string, portOffset: number): string {
  try {
    const u = new URL(base);
    u.pathname = u.pathname.replace(/\/mcp$/, '') + '/health';
    if (portOffset > 0) u.port = String(Number(u.port) + portOffset);
    return u.toString();
  } catch {
    return base;
  }
}

function eventFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createEventService(deps: EventServiceDeps): EventService {
  const interval = deps.probeIntervalMs ?? 10_000;
  const timeout = deps.healthTimeoutMs ?? 2_000;
  const threshold = deps.failThreshold ?? 2;
  const log = deps.log ?? (() => {});
  const now = () => Math.floor(Date.now() / 1000);

  const state = new Map<string, DeviceStatus>();
  const subscribers = new Set<{
    write(chunk: string): unknown;
    end(): unknown;
  }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let round = 0;

  /** 设备状态帧（事件 data 载荷）——desktop 端 apply_state 单一入口用 */
  function frame(dev: DeviceStatus) {
    return {
      device: dev.name,
      url: dev.url,
      agent: { online: dev.agent.online, uptime: dev.agent.uptime, probedAt: dev.agent.probed_at },
      term: { online: dev.term.online, uptime: dev.term.uptime, probedAt: dev.term.probed_at },
    };
  }

  function broadcast(event: string, data: unknown) {
    const f = eventFrame(event, data);
    for (const s of subscribers) {
      try {
        s.write(f);
      } catch {
        subscribers.delete(s); // 写失败（连接已断）剔除
      }
    }
  }

  /** 注册表同步：新增设备入表、URL 变化广播、移除设备广播 */
  async function syncRegistry() {
    let devices: Array<{ name: string; url: string }> = [];
    try {
      devices = await deps.listDevices();
    } catch (err) {
      log('[events] registry sync failed:', err instanceof Error ? err.message : err);
      return; // 读注册表失败本轮跳过（openclaw.json 重写瞬间等）
    }
    const seen = new Set<string>();
    for (const d of devices) {
      seen.add(d.name);
      const st = state.get(d.name);
      if (!st) {
        state.set(d.name, { name: d.name, url: d.url, agent: fresh(), term: fresh() });
        log('[events] new device:', d.name, d.url);
      } else if (st.url !== d.url) {
        st.url = d.url;
        broadcast('device.updated', frame(st));
      }
    }
    for (const [name, st] of state) {
      if (!seen.has(name)) {
        state.delete(name);
        broadcast('device.removed', { device: name });
      }
    }
  }

  async function parseHealth(res: Response): Promise<ProbeResult> {
    if (!res.ok) return { ok: false, uptime: 0 };
    const j = await res.json().catch(() => null);
    const ok = !!j && (j.status === 'ok' || j.ok === true);
    return { ok, uptime: Number(j?.uptime) || 0 };
  }

  async function probeHealth(url: string): Promise<ProbeResult> {
    try {
      const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
      return await parseHealth(res);
    } catch {
      return { ok: false, uptime: 0 }; // 超时/连接拒绝 = 不可达
    }
  }

  /** 应用单次探测结果：防抖翻转状态，返回是否有变化（广播由调用方按设备级聚合） */
  function applyResult(dev: DeviceStatus, which: 'agent' | 'term', probe: ProbeResult): {
    flipped: boolean;
    uptimeDrop: boolean;
  } {
    const svc = dev[which];
    if (probe.ok) {
      // agent 重启特征：uptime 大幅回退（如从 10000 → 10）——需要即时校准广播
      const uptimeDrop = svc.online && probe.uptime > 0 && svc.uptime > probe.uptime + 60;
      const flipped = !svc.online;
      svc.fail_count = 0;
      svc.online = true;
      svc.uptime = probe.uptime > 0 ? probe.uptime : svc.uptime;
      svc.probed_at = now();
      return { flipped, uptimeDrop };
    }
    svc.fail_count += 1;
    if (svc.online && svc.fail_count >= threshold) {
      svc.online = false;
      return { flipped: true, uptimeDrop: false };
    }
    return { flipped: false, uptimeDrop: false };
  }

  async function probeRound() {
    await syncRegistry();
    await Promise.allSettled(
      [...state.values()].map(async (dev) => {
        const beforeAny = dev.agent.online || dev.term.online;
        const [a, t] = await Promise.all([
          probeHealth(healthUrl(dev.url, 0)),
          probeHealth(healthUrl(dev.url, 10)),
        ]);
        const ra = applyResult(dev, 'agent', a);
        const rt = applyResult(dev, 'term', t);
        const afterAny = dev.agent.online || dev.term.online;
        // 设备级事件聚合（agent/term 不分别广播）：
        //   全离线→任一在线 = device.online；任一在线→全离线 = device.offline
        //   服务级翻转 / uptime 回退 = device.updated
        if (!beforeAny && afterAny) broadcast('device.online', frame(dev));
        else if (beforeAny && !afterAny) broadcast('device.offline', frame(dev));
        else if (ra.flipped || rt.flipped || ra.uptimeDrop || rt.uptimeDrop) {
          broadcast('device.updated', frame(dev));
        }
      }),
    );
    // 每 6 轮（60s）低频校准广播：uptime 基准刷新（desktop 本地跳动锚点）
    // 正常场景不产生事件风暴（每设备 1 事件/分钟）
    round += 1;
    if (round % 6 === 0) {
      for (const dev of state.values()) {
        if (dev.agent.online || dev.term.online) broadcast('device.updated', frame(dev));
      }
    }
  }

  function schedule() {
    timer = setTimeout(async () => {
      await probeRound().catch((err) => log('[events] probe round failed:', err));
      schedule();
    }, interval);
    // S14：探测定时器不阻塞进程退出——否则 close() 后 setTimeout 仍挂起事件循环
    timer.unref();
  }

  return {
    start() {
      if (timer) return;
      schedule();
    },

    async handleEvents(req, res) {
      // 先同步注册表（服务刚启动/探测循环未跑时 state 可能为空——连接即拿全量）
      await syncRegistry();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n'); // 客户端断线重连提示
      res.write(eventFrame('snapshot', { devices: [...state.values()].map(frame) }));
      const sub = { write: (c: string) => res.write(c), end: () => res.end() };
      subscribers.add(sub);
      const drop = () => {
        subscribers.delete(sub);
      };
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
    },

    notifyHeartbeat(name, newUrl) {
      const st = state.get(name);
      if (!st) return; // 未入表（首次注册等）——下一轮 syncRegistry 自愈
      if (st.url !== newUrl) {
        st.url = newUrl;
        broadcast('device.updated', frame(st));
        log('[events] heartbeat URL updated:', name, newUrl);
      }
    },

    notifyRemoved(name) {
      state.delete(name);
      broadcast('device.removed', { device: name }); // 无条件广播（幂等，客户端忽略未知设备名）
    },

    async probeNow() {
      await probeRound();
    },

    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const s of subscribers) {
        try {
          s.end();
        } catch {
          /* 已断开 */
        }
      }
      subscribers.clear();
    },
  };
}
