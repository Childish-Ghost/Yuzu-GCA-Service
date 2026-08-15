/**
 * events.test.ts — 事件服务单测（node:test，tsc 编译后 `node --test dist/` 运行）
 * 覆盖：snapshot / 探测结果应用 / 防抖判离线 / 恢复在线 / 注册表同步 / heartbeat / revoke
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventService, type EventService } from './events.js';

/** 按 URL 路由的 mock fetch：routes 未命中的 URL 一律失败（模拟不可达） */
function makeFetch(routes: Record<string, { ok: boolean; body: unknown }>) {
  return (async (url: string) => ({
    ok: routes[url]?.ok ?? false,
    json: async () => routes[url]?.body ?? null,
  })) as unknown as typeof fetch;
}

/** mock SSE 订阅者（收集 write 帧） */
class FakeRes {
  frames: string[] = [];
  writeHead(_code: number, _h: Record<string, string>) {}
  write(c: string) {
    this.frames.push(c);
    return true;
  }
  on(_ev: string) {}
  end() {}
}

class FakeReq {
  on(_ev: string) {}
}

interface Fixture {
  svc: EventService;
  res: FakeRes;
  devices: Array<{ name: string; url: string }>;
  routes: Record<string, { ok: boolean; body: unknown }>;
  setDevices: (d: Array<{ name: string; url: string }>) => void;
  setRoute: (url: string, r: { ok: boolean; body: unknown }) => void;
}

function makeFixture(initialDevices: Array<{ name: string; url: string }>): Fixture {
  const devices = [...initialDevices];
  const routes: Record<string, { ok: boolean; body: unknown }> = {};
  const f: Fixture = {
    svc: null as unknown as EventService,
    res: new FakeRes(),
    devices,
    routes,
    setDevices(d) {
      devices.splice(0, devices.length, ...d);
    },
    setRoute(url, r) {
      routes[url] = r;
    },
  };
  f.svc = createEventService({
    listDevices: async () => [...f.devices],
    fetchImpl: makeFetch(routes),
    probeIntervalMs: 60_000, // 测试不依赖定时器，用 probeNow 手动驱动
    healthTimeoutMs: 500,
    failThreshold: 2,
    log: () => {},
  });
  return f;
}

/** 连接一个订阅者（模拟 desktop 连 /events；await 保证 snapshot 已写） */
async function subscribe(f: Fixture): Promise<void> {
  await f.svc.handleEvents(new FakeReq() as never, f.res as never);
}

/** 从帧流解析出事件：{event, data}[] */
function parseFrames(res: FakeRes): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const frame of res.frames) {
    const evMatch = frame.match(/^event: (\S+)\n/m);
    const dataMatch = frame.match(/^data: (.*)\n/m);
    if (evMatch && dataMatch) {
      out.push({ event: evMatch[1], data: JSON.parse(dataMatch[1]) });
    }
  }
  return out;
}

const DEV = 'http://10.0.0.2:3001/mcp';
const AGENT_HEALTH = 'http://10.0.0.2:3001/health';
const TERM_HEALTH = 'http://10.0.0.2:3011/health';

test('连接即发 snapshot：全量设备 + 初始状态', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  await subscribe(f);
  const events = parseFrames(f.res);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'snapshot');
  assert.equal(events[0].data.devices.length, 1);
  const d = events[0].data.devices[0];
  assert.equal(d.device, 'gca-win11');
  assert.equal(d.agent.online, false);
  assert.equal(d.term.online, false);
});

test('探测成功 → agent/term 在线并广播 device.online', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', device: 'gca-win11', uptime: 18057 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', device: 'gca-win11', uptime: 18054 } });
  await subscribe(f);
  await f.svc.probeNow();

  const events = parseFrames(f.res).filter((e) => e.event !== 'snapshot');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'device.online');
  assert.equal(events[0].data.agent.online, true);
  assert.equal(events[0].data.agent.uptime, 18057);
  assert.equal(events[0].data.term.online, true);
  assert.ok(events[0].data.agent.probedAt > 0);
});

test('防抖：单次失败不判离线，连续 2 次失败才广播 device.offline', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  // 初始在线
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  await subscribe(f);
  await f.svc.probeNow();

  // 失败 1 次（未达阈值）
  f.setRoute(AGENT_HEALTH, { ok: false, body: null });
  f.setRoute(TERM_HEALTH, { ok: false, body: null });
  f.res.frames = [];
  await f.svc.probeNow();
  assert.equal(parseFrames(f.res).length, 0, '单次失败不应广播');

  // 失败 2 次（达阈值）
  f.res.frames = [];
  await f.svc.probeNow();
  const offline = parseFrames(f.res).filter((e) => e.event === 'device.offline');
  assert.equal(offline.length, 1);
  assert.equal(offline[0].data.device, 'gca-win11');
  assert.equal(offline[0].data.agent.online, false);
  assert.equal(offline[0].data.term.online, false);
});

test('恢复：探测成功即广播 device.online（1 次成功即恢复）', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: false, body: null });
  f.setRoute(TERM_HEALTH, { ok: false, body: null });
  await subscribe(f);
  await f.svc.probeNow();
  await f.svc.probeNow(); // 判离线

  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 5 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', uptime: 5 } });
  f.res.frames = [];
  await f.svc.probeNow();
  const online = parseFrames(f.res).filter((e) => e.event === 'device.online');
  assert.equal(online.length, 1);
  assert.equal(online[0].data.agent.online, true);
});

test('term 探测失败 agent 成功 → agent 在线 / term 离线（四态 ② 数据源）', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 99 } });
  f.setRoute(TERM_HEALTH, { ok: false, body: null }); // term 不可达（未部署/故障）
  await subscribe(f);
  await f.svc.probeNow();
  const ev = parseFrames(f.res).filter((e) => e.event === 'device.online')[0];
  assert.equal(ev.data.agent.online, true);
  assert.equal(ev.data.term.online, false);
});

test('heartbeat URL 更新 → 立即广播 device.updated（不等下一轮探测）', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  await subscribe(f);
  await f.svc.probeNow();
  f.res.frames = [];

  f.svc.notifyHeartbeat('gca-win11', 'http://10.0.0.9:3001/mcp');
  const updated = parseFrames(f.res).filter((e) => e.event === 'device.updated');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].data.url, 'http://10.0.0.9:3001/mcp');
});

test('注册表新增设备 → 进入状态表；注册表移除 → 广播 device.removed', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', uptime: 100 } });
  await subscribe(f);
  await f.svc.probeNow();

  // 新增 android
  f.setDevices([
    { name: 'gca-win11', url: DEV },
    { name: 'gca-android', url: 'http://10.0.0.3:3003/mcp' },
  ]);
  f.setRoute('http://10.0.0.3:3003/health', { ok: true, body: { status: 'ok', uptime: 7 } });
  f.setRoute('http://10.0.0.3:3013/health', { ok: false, body: null });
  f.res.frames = [];
  await f.svc.probeNow();
  const evs = parseFrames(f.res);
  assert.ok(evs.some((e) => e.event === 'device.online' && e.data.device === 'gca-android'), '新设备应被探测并广播 online');

  // 移除 win11（revoke 场景）
  f.setDevices([{ name: 'gca-android', url: 'http://10.0.0.3:3003/mcp' }]);
  f.res.frames = [];
  await f.svc.probeNow();
  const removed = parseFrames(f.res).filter((e) => e.event === 'device.removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].data.device, 'gca-win11');
});

test('notifyRemoved（revoke hook）→ 立即广播 device.removed', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  await subscribe(f);
  f.svc.notifyRemoved('gca-win11');
  const removed = parseFrames(f.res).filter((e) => e.event === 'device.removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].data.device, 'gca-win11');
});

test('uptime 大幅回退（agent 重启特征）→ 广播 device.updated 校准', async () => {
  const f = makeFixture([{ name: 'gca-win11', url: DEV }]);
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 18057 } });
  f.setRoute(TERM_HEALTH, { ok: true, body: { status: 'ok', uptime: 18054 } });
  await subscribe(f);
  await f.svc.probeNow();

  // agent 重启：uptime 归零（回退 > 60s 即触发校准广播）
  f.setRoute(AGENT_HEALTH, { ok: true, body: { status: 'ok', uptime: 12 } });
  f.res.frames = [];
  await f.svc.probeNow();
  const updated = parseFrames(f.res).filter((e) => e.event === 'device.updated');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].data.agent.uptime, 12);
});
