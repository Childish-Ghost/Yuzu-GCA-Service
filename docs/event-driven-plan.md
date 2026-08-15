# 事件驱动设备状态 · 实施计划

> 2026-08-12 · 主线下一步（MASTER P2）· 方案 v3
> 需求：**先把 Windows + server 逻辑跑顺，再完成其他客户端编写和测试**

---

## 1. 目标

根治当前轮询体系的三个痛点，并给出多客户端统一的状态分发通道：

| 痛点 | 现状 | 目标 |
|------|------|------|
| 探测卡顿 | desktop 每 15s 逐设备直连 HTTP probe（3s 超时）阻塞 UI | 探测全部收权到 gca-server，UI 零探测 |
| 状态延迟 | 最多 15s + uptime 校准延迟 | 秒级（10s 探测周期 + 事件即时推送） |
| 多端不一致 | desktop / 面板各探各的 | 单一事实源（gca-server），全端订阅同一流 |

## 2. 架构（方案 v3）

```
gca-server（单一事实源）
  ├─ 状态表（内存）：每设备 agent/term 两层 {online, uptime, probed_at, fail_count}
  ├─ 探测循环：每 10s 一轮，并行 GET 设备 /health（agent 注册表 URL，term 端口+10）
  │    └─ 防抖：连续 2 次失败判离线；1 次成功即在线
  └─ /events SSE（Bearer auth）：snapshot（连接即发全量）+ 增量变化事件
        ├─ device.online  / device.offline
        ├─ device.updated（agent/term 状态、URL 变动）
        └─ device.removed（revoke）
desktop-rs（订阅端）：SSE 在线时免探测（卡顿根治）；断线回退 15s 轮询 + probe（现状保留）
```

- **探测协议**：三端 /health 统一返回 `status / device / uptime`（agent/term/node client 已确认一致），探测只取这三字段
- **uptime 显示**：事件带 uptime + probed_at → desktop 现有 `uptime_base/probed_at` 本地跳动机制**零改动复用**
- **心跳保留**：/heartbeat 负责"地址对不对"（IP 变动立即广播 device.updated），探测负责"活没活"——互补
- **事件风暴控制**：只发状态变化，不发周期心跳
- **断线对齐**：快照式设计（重连收 snapshot 即全量对齐，幂等）

### 设备行四态显示（desktop 设备列表，替换 app.rs:805-814 单布尔）

| 状态 | agent | term | 显示 | 颜色 |
|------|:---:|:---:|------|------|
| ① 全在线 | ✓ | ✓ | `在线` + uptime | 绿 (12,163,12) |
| ② 仅 Agent | ✓ | ✗/未确认 | `仅 Agent` + uptime | 黄 (185,126,0) — term 不在线 |
| ③ 仅终端 | ✗/未确认 | ✓ | `仅终端`（无 agent uptime） | 蓝 (57,135,229) — agent 不在线 |
| ④ 离线 | ✗ | ✗ | `离线` | 红 (229,57,53) |

四色设计：绿=全在线 / 黄=term 不在线 / 蓝=agent 不在线 / 红=全离线。黄蓝在红绿色盲（最常见 CVD）下仍可区分；蓝取项目色板 `--blue #3987e5` 同值；文本与颜色双编码（状态名写明，颜色辅助扫读）。

- 设备"在线" = agent 或 term 任一确认在线（②③ 黄色提示"部分服务"）；④ 全离线才红
- term 未确认（灰/未部署，如 Android）按"不可用"计，不误报故障
- `DeviceRow` 从 `online: bool` 升级为 `agent: Option<bool>` / `term: Option<bool>`（旧轮询路径兼容：apply_probe 填 agent 层，term 置 None）

## 3. 实施阶段

### 阶段一（本轮）：Windows + server 主链路闭环

| 步骤 | 内容 | 验收标准 |
|------|------|---------|
| 1 | `server/src/events.ts`（新）：状态表 + 探测循环 + SSE 广播 | ✅ 完成（9 项单测全绿，node:test） |
| 2 | `gca-server.ts`：挂 `/events` 路由 + heartbeat/revoke/rename 广播 hook | ✅ 完成（curl -N 实测：snapshot 全量 + 真实探测 agent/term 在线 + revoke 即时广播） |
| 3 | `desktop-rs/src/http.rs`：SSE 订阅客户端（tag 回调复用） | ✅ 完成（subscribe_events：event/data 帧解析，events:<evt> tag 推送，closed 断线通知） |
| 4 | `desktop-rs/src/devices.rs`：`DeviceRow` 分层（`agent: Option<bool>` / `term: Option<bool>`）+ `apply_event` + snapshot | ✅ 完成（8 项单测：snapshot/State/removed/四态判定/浮点 uptime 容错） |
| 5 | `desktop-rs/src/app.rs`：连接管理（登录连 /events、指数退避重连、断线回退轮询）+ **设备行四态显示**（替换 app.rs:805-814 单布尔） | ✅ 完成（代码级；实机验证待用户重启桌面端） |
| 6 | 端到端：desktop → VM server → 本机 agent/term 全套 | ✅ server 侧实测通过（VM /events 真实探测：gca-win11 双在线 + Android 仅 Agent）；44 项测试全绿（原 36 + 新增 8） |
| 7 | 部署 VM（npm run build → scp → systemctl restart）+ 验证 | ✅ 已部署（VM /events 上线，snapshot + device.online 实测） |

**阶段一完成状态**：代码全部落地 + VM 部署 + server 侧实测通过；desktop 实机效果（四态显示/实时指示/断线回退）待用户重启桌面端验证。

### 阶段二（本轮，2026-08-12 重规划）：面板接入 /events

> **重规划**：Android 子项从阶段二**摘除**——Android 端无状态显示面（MainActivity 仅静态文字），
> node bundle 阶段不再单独做订阅；**P1 原生化已完成（2026-08-13）**——/events 订阅接入移至 P3（认证/事件/审计对齐）。
> 阶段二范围收敛为：面板 dashboard 接入。

| 客户端 | 接入内容 | 状态 |
|--------|---------|------|
| 面板 dashboard | 设备行加在线状态列 + SSE 订阅（fetch 流式，Bearer header，EventSource 不支持自定义 header） | 本轮范围 |
| ~~Android（node bundle，3003）~~ | ~~fetch 流式读 /events~~ → **P1 原生化完成，/events 接入移至 P3** | 挂起→P3 |
| 只 term 设备 | 注册表模型升级（services 声明）——届时评估 | 有实际需求再做 |

## 4. 改动清单（阶段一）

| 文件 | 改动 | 规模 |
|------|------|------|
| `server/src/events.ts`（新） | 状态表 + 探测循环 + SSE 广播 + 事件类型 | ~220 行 |
| `server/src/gca-server.ts` | /events 路由 + heartbeat/revoke/rename 广播 hook | ~30 行 |
| `desktop-rs/src/http.rs` | SSE 订阅客户端（读流、解析 event/data、重连） | ~80 行 |
| `desktop-rs/src/devices.rs` | `DeviceRow` 分层（agent/term Option<bool>）+ `Evt` 枚举 + `apply_event` + snapshot | ~80 行 |
| `desktop-rs/src/app.rs` | 登录后订阅、事件分发、刷新逻辑切换、**设备行四态显示**（在线/仅 Agent/仅终端/离线） | ~120 行 |
| `docs/api.md` | /events 端点文档 | ~20 行 |

## 5. 验证方法

- server 单测：mock 探测（成功/失败/防抖阈值）、广播触发
- 实测事件流：`curl -N -H "Authorization: Bearer <token>" http://<server>/events`
- 隔离实例法：`GCA_TERM_PORT=3012` 起 term + agent 3002，观察事件（沿用 3012 验证法）
- 断线演练：停 server → desktop 显示"轮询"并恢复旧行为；起 server → 重连收 snapshot 对齐
- 回归：`cargo test --workspace` 36 项全绿

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| SSE 断开导致状态停滞 | desktop 自动回退现有轮询 + probe（原逻辑保留为 fallback） |
| 事件风暴（大量状态变化） | 只发变化；探测防抖（连续 2 次失败）压震荡 |
| VM 重启状态表丢失 | snapshot 全量重建，客户端无需补偿逻辑 |
| 心跳与探测竞态（IP 刚更新探测用旧地址） | 心跳触发立即广播 + 下一轮探测用新 URL，至多一个探测周期误差 |
| 探测自身阻塞 server | 并行探测 + 2s 超时 + 不阻塞请求处理（事件广播独立于探测循环） |

## 7. 已知限制（记录在案，后置）

1. Android 无 term → 面板/desktop 对 Android 显示"仅 Agent"（黄色，阶段一四态已覆盖）；Android 自身显示设备状态的面（主界面/通知栏）**挂起至原生化**，届时一并接入 /events
2. 只 term 设备仍是注册表盲区（不升级模型，等实际需求）
3. term 端口按 +10 推断（当前部署全覆盖）

## 8. 完成定义（阶段一）

- [x] server /events 端点上线（VM 部署）——2026-08-12 实测 snapshot + device.online + revoke 广播
- [x] desktop 订阅接入：状态秒级刷新、零探测卡顿、断线回退正常——实机验证通过（○ 轮询 ↔ ● 实时切换）
- [x] 44 项测试全绿（原 36 + server 9 + desktop 8）+ 端到端实测通过
- [x] docs/api.md 更新 + 本计划闭环标记

## 8b. 完成定义（阶段二 · 面板）

- [x] 设备表加"状态"列（四态：在线/仅 Agent/仅终端/离线，四色同 desktop）——事件驱动实时刷新——2026-08-12
- [x] SSE 订阅：fetch 流式 + Bearer header（EventSource 不支持自定义 header，不引入）；断线 3s 重连 + 回退 15s 轮询 + ● 实时/○ 轮询指示
- [x] 概览"在线设备"改为 在线/总数（事件数据）
- [x] server 构建 + 本地实测（隔离端口 18791）+ VM 部署验证（snapshot + device.updated 实测）
- [x] 计划/MASTER 闭环标记

**阶段二完成**（2026-08-12）：面板已订阅 /events——设备状态列实时四态、断线回退轮询；Android 子项挂起至 P1 原生化（见 §3 重规划）。
