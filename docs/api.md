# GCA 前端接口文档（UI 改造交接用）

> 面向 UI 改造（MIMO）：desktop-rs（egui）需要对接的全部接口 + 数据模型。
> 2026-08-05 定稿 · 配套项目状态见 project-status.md

## 1. 架构与端口

```
gca-desktop.exe（控制端 UI，本机）
  ├─ gca-server（VM <网关IP>:18790）——控制面 REST
  ├─ gca-agent.exe（设备 3001）——AI 通道 MCP（经 gca-server 代理或本机直连）
  └─ gca-term.exe（设备 3011）——人终端服务（经 gca-server 代理或本机直连）
```

认证：除标注外，全部接口 `Authorization: Bearer <token>`。

---

## 2. gca-server（控制面）REST API

### 基础
| 方法/路径 | 说明 |
|---|---|
| GET `/health` | 探活：`{ok:true, service:"gca-server", uptime}` |
| GET `/devices` | 设备列表：`{devices:[{name,url,transport,hasAuth,machineId}], count}` |
| POST `/devices/:name/revoke` | 撤销设备 |
| POST `/devices/:name/rename` | 重命名 `{newName}` |
| POST `/devices/:name/reurl` | 改设备地址 `{url}` |

### 注册/配对
| 方法/路径 | 说明 |
|---|---|
| POST `/pair/init` | 生成 6 位配对码：`{code, expiresInSec:600}` |
| POST `/pair/claim` | 新设备用码注册（无认证）：`{code, deviceName, port}` → `{ok, pairingToken}` |
| POST `/register` | 已登录设备注册（确认码审批）：`{deviceName, machineId, port}` → `{id, code, status:"pending"}` |

### 审批流（ops）
| 方法/路径 | 说明 |
|---|---|
| POST `/ops/request` | 高危操作申请（设备 token 认证，device 由服务端用认证身份覆盖）：`{operation, detail}` → `{id, expiresInSec, status}`（2026-08-12 审查 M6：响应不含确认码——码只走 owner 通道） |
| POST `/ops/approve` | 确认码批准（AI/面板通道）：`{code}` → `{ok, operation, device}` |
| POST `/ops/reject` | 拒绝：`{code}` |
| GET `/ops?status=pending` | **审批列表（owner，2026-08-14）**：`{ops: [{id, device, operation, status, detail, createdAt, deviceIp}]}`——不含 code |
| GET `/ops/events` | **审批事件流（owner，SSE，2026-08-14）**：连接即发 `op.snapshot`（pending 全量）+ `ready`，实时 `op.created` / `op.resolved`——App 审批下发通道 |
| POST `/ops/:id/approve` | **按 id 批准（owner，2026-08-14）**：App/卡片回调通道 → `{ok, operation, device}`；device_registration 自动落地注册 |
| POST `/ops/:id/reject` | **按 id 拒绝（owner，2026-08-14）**：→ `{ok}` |
| POST `/ops/card-action` | **飞书卡片按钮回调（本地，2026-08-14）**：`{opId, action: approve/reject, signature, senderId}`——HMAC 签名 + owner allowlist 校验 → 审批 + 卡片回写 |
| GET `/ops/:id` | 轮询状态 |

### 其他
| 方法/路径 | 说明 |
|---|---|
| POST `/push` | 推送通知（飞书，2026-08-14 起微信审批通道移除）：`{text}` |
| POST `/clipboard/push` | 剪贴板推送：`{content, type:"text"|"image", deviceId}` |
| GET `/clipboard/latest` | 拉取最新剪贴板：`{content, type, deviceId, updatedAt}` |
| POST `/audit` | 上报审计：`{deviceId, action, detail, status}`（客户端推送可选：`GCA_AUDIT_PUSH=1`，默认本地留痕——INT-005，2026-08-12） |
| GET `/audit?limit=&device=` | 查审计 |
| POST `/heartbeat` | 设备 IP 心跳（desktop 每 5 分钟）：`{machineId, port}` → 按来源 IP 更新设备 URL，`{ok, url, updated}`（2026-08-11） |
| POST `/device/:name/mcp` | MCP 代理转发（到设备 3001/mcp） |
| POST `/device/:name/term/*` | 终端服务代理转发（到设备 3011/term/*，端口 +10 约定；SSE query 透传，2026-08-10 修复 %3F 转义） |

### 设备状态事件（2026-08-12 新增）
| 方法/路径 | 说明 |
|---|---|
| GET `/events` | **设备状态 SSE 流**（Bearer 认证）——gca-server 集中探测（10s 周期，agent `/health` + term 端口+10 `/health`，连续 2 次失败判离线），状态变化广播，desktop 订阅免轮询。连接即发全量 `snapshot`，断线重连自动对齐（retry: 3000） |

事件格式（SSE `event:`/`data:` 帧，空行分隔）：
```
event: snapshot        data: {"devices":[{device,url,agent,term}...]}   // 连接即发全量
event: device.online   data: {device,url,agent,term}                    // 任一服务恢复在线
event: device.offline  data: {device,url,agent,term}                    // 全部服务离线（防抖后）
event: device.updated  data: {device,url,agent,term}                    // URL 变动 / 服务级翻转 / uptime 校准
event: device.removed  data: {"device":name}                            // revoke / 注册表移除
```
服务状态字段：`agent`/`term` 各为 `{online, uptime, probedAt}`（probedAt 为 epoch 秒，客户端本地跳动校准锚点）。设计见 docs/event-driven-plan.md。

### 局域网服务发现（mDNS，INT-004 · 2026-08-12 新增）

| 项 | 值 |
|---|---|
| 服务类型 | `_gca-server._tcp.local.`（标准 DNS-SD） |
| 传输 | UDP 组播 `224.0.0.251:5353`（应答 TTL 120s，server 每 60s 重发 announce） |
| 应答内容 | PTR → SRV（端口 18790）+ TXT（version）+ A（附加节） |
| 客户端约定 | PTR 查询带 **QU 位**（QCLASS=0x8001）→ server 单播应答到查询源端口（临时端口即可收包，无需绑 5353/加组）；地址 = 应答源 IP + SRV 端口 |
| 实现 | server `src/mdns.ts`（Node dgram，零依赖）；desktop `src/mdns.rs`（std UdpSocket，逐本机 IP 钉接口发查询——Windows 默认组播接口可能落在虚拟网卡）；desktop 无应答回退全网段端口扫描（scan.rs） |

**通讯流程**：

```
┌─────────────────────────┐                        ┌──────────────────────────────┐
│  desktop-rs (<本机IP>) │                        │  gca-server (VM <网关IP>)   │
│  mdns.rs / scan.rs      │                        │  mdns.ts                    │
└───────────┬─────────────┘                        └──────────────┬───────────────┘
            │                                                    │
            │                          ┌─────────────────────────┼─────────────┐
            │                          │ ① 启动：bind 0.0.0.0:5353│             │
            │                          │   + join 组播 224.0.0.251│             │
            │                          └─────────────────────────┴─────────────┘
            │                          ┌─────────────────────────────────────────┐
            │                          │ ② announce（多播 224.0.0.251:5353）：     │
            │                          │    PTR→"GCA Server" + SRV(端口18790)     │
            │◄─────────────────────────│    + TXT(version) + A(附加节)            │
            │        多播公告           │    TTL=120s                             │
            │                          │ ③ 每 60s 重发 announce（防缓存过期）      │
            │                          └─────────────────────────────────────────┘
            │
            │  ④ 用户点「🔍 嗅探局域网服务器」→ discover(timeout 2s)
            │
            │  ⑤ for 每个本机 IPv4（<本机IP> / <虚拟网IP> …）：
            │     新建 socket 绑 (该IP, 0)     ← 钉组播出口（虚拟网卡坑）
            │     发 PTR 查询：
            │     ┌──────────────────────────────────────────────────┐
            │     │ ID=0x61ca · QD=1                                 │
            │     │ 名称 = _gca-server._tcp.local.                   │
            │     │ QTYPE=PTR(12) · QCLASS=0x8001 = IN + QU 位       │
            │     │        ↑  QU 位 → 应答改单播，临时端口可收        │
            │     └──────────────────────────────────────────────────┘
            │──────────────────────────────────────────────────────────►
            │        组播 224.0.0.251:5353                             │
            │                                                          │  ⑥ shouldRespond 命中
            │                                                          │     （服务名 + PTR/ANY）
            │                                                          │     组装应答：
            │                                                          │     AN=PTR+SRV+TXT
            │                                                          │     AR=A记录
            │                                                          │     （复制请求 ID）
            │  ⑦ 单播应答（QU → 发回查询源 IP:端口，非组播）            │
            │◄──────────────────────────────────────────────────────────
            │     {QR=1, ANCOUNT=3, ARCOUNT=N}
            │
            │  ⑧ parse_response：扫 AN+AR 找 SRV(type=33) → 端口 18790
            │     服务器地址 = 应答包源 IP + SRV 端口
            │     → 得 "http://<网关IP>:18790"          ← 跨机实测 ✅
            │
            │  ⑨ 发现即返回；若全部接口超时无应答
            │     → 回退 scan.rs：全网段 254 IP 并行连 18790
            │       + /health 验证（老机制，保留兜底）
            │
            │  ⑩ 登录页展示「嗅探结果」列表 → 点击即登录
            ▼
```

关键点（对应 project-status.md 踩坑史 0d）：QU 位是核心（临时端口可收单播应答）；逐本机 IP 钉组播出口（Windows 默认组播接口可能落虚拟网卡——实测 172.29 不出物理网）；服务器地址 = 应答源 IP + SRV 端口（A 记录留给标准 mDNS 工具）；超时自动回退端口扫描。

---

## 3. gca-agent（AI 通道）MCP 工具

MCP streamable HTTP：`POST /mcp`，JSON-RPC 2.0，Bearer 配对 token。

### 工具全表

| 工具 | 入参 | 返回要点 | 审批 |
|---|---|---|---|
| `sysinfo` | `{}` | os/cpu/memory/disk/network/drives/collectedAt | 只读 |
| `exec` | `{command, cwd?, timeout?}` | status=executed: stdout/stderr/exitCode/cwd；confirmation_required；blocked | **三级别** |
| `confirm` | `{}` | 确认最近待处理操作 | — |
| `process_list` | `{filter?, sort?, limit?}` | 进程数组 | 只读 |
| `file_list` | `{path, pattern?, recursive?}` | entries[{name,path,type,size,mtime}] | 只读 |
| `file_read` | `{path, startLine?, endLine?}` | content/totalLines | 只读 |
| `file_write` | `{path, content, mode?, createDirs?}` | 需确认 | 确认 |
| `file_move` | `{source, dest}` | 需确认 | 确认 |
| `file_delete` | `{path, recursive?}` | 需确认（禁删根） | 确认 |
| `power` | `{action: shutdown/restart/sleep/hibernate/abort}` | 需确认。⚠️ 双授权路径（C4，2026-08-12 审查记录）：node 版走 gca-server 远程 ops 审批（/ops/request → 飞书确认码/交互卡片）；rust 版走本地 pending+confirm（token 精确确认）。部署互斥（desktop 优先 rust exe，node bundle 为回退），实际不会同机并存 | 确认 |
| `service` | `{action: list/start/stop/restart, name?}` | list 只读；start/stop/restart 确认 | 分级 |
| `exec_background` | `{command, cwd?}` | 后台执行 | 确认 |
| `screenshot` | `{quality?, ocr?}` | text 元数据 + image content 块 | consent/确认 |
| `remote_input` | `{action, x?, y?, button?, delta?, text?}` | 键鼠控制 | consent/确认 |
| `clipboard_sync` | `{action: get/set, text?}` | 剪贴板 | 确认 |
| `notify_send` | `{message, title?}` | 桌面通知 | 自动 |
| `screen_consent` | `{minutes}` | 截图授权窗口 | 授予需确认 |
| `input_consent` | `{minutes}` | 键鼠授权窗口 | 授予需确认 |
| `file_serve` | `{path}` | 铸票据：`{url: http://设备:3001/transfer/<token>}` | 确认 |
| `file_fetch` | `{url, targetPath}` | 下载（票据 URL 免确认） | 票据/确认 |

### 通用返回形态
```json
{ "content": [{ "type": "text", "text": "{JSON}" }], "isError": false }
```
text 内 JSON：`status` ∈ `ok|executed|confirmation_required|blocked|error|confirm_failed|granted|revoked|serving|fetched|written|read|captured`

---

## 4. gca-term（人终端服务）

**真终端模型（2026-08-06 起）**：ConPTY 伪终端 + SSE 流式输出 + 输入/resize 通道。
Bearer 独立 token（GCA_TERM_TOKEN）。旧命令级 RPC（exec/interrupt/close）已废弃 404。

| 端点 | 入参 | 返回 |
|---|---|---|
| `GET /term/sse?cols=X&rows=Y` | query 带网格尺寸（会话创建即用正确尺寸——避免 shell 行号偏移；2026-08-10） | SSE 流：`data: <base64 输出块>`（心跳 `: p`）；断开即流结束 |
| `POST /term/input` | `{data: <base64 键盘字节>}` | `{status:"ok"}`（写入 ConPTY；客户端应串行化+失败重试） |
| `POST /term/resize` | `{cols, rows}` | `{status:"ok", cols, rows}` |
| `POST /term/shell` | `{shell: cmd\|powershell}` | 切换 shell（重建会话，沿用 LAST_SIZE 尺寸） |
| `POST /term/ls` | `{path}` | 目录列表（树，MCP content 包装） |
| `POST /term/sysinfo` | `{}` | 平台/盘符（终端页初始化） |

会话管理：懒启动（默认 cmd）；空闲回收（GCA_TERM_IDLE_MS，默认 5 分钟，有 SSE 订阅者不回收）；
死会话自动重生（子进程秒退时 get_or_spawn 换新，2026-08-09）；
ConPTY 主机默认系统 conhost（`GCA_CONPTY_SIDELOAD=1` 切 sideload OpenConsole，2026-08-11）。
| `GET /health` | — | 探活 |

---

## 5. desktop-rs UI 结构与接口调用点

### 页面
| 页面 | 数据来源 | 关键操作 |
|---|---|---|
| 登录页 | gca-server /health + /devices | 登录/嗅探/本机模式/注册入口 |
| 设备列表 | gca-server /devices | 在线探测（每 15s）、打开详情 |
| 设备详情 | agent sysinfo（经代理） | 重命名/撤销 |
| 终端页 | gca-term | exec/shell 切换/目录树 |
| AI 聊天 | gca-server 管理 MCP 工具 chat_ai（POST /mcp tools/call，非独立 REST 端点——D3 更正） | 消息收发 |
| 日志 | 本机 | 清空 |

### UI 状态关键字段（devdetail.rs）
```
DeviceDetailState:
  name/url/online/uptime/direct/machineId/transport/hasAuth
  sysinfo: Vec<(label, value)>          // 详情页表格行
  lines: Vec<TermLine{kind,text}>       // 终端输出（Cmd/Out/Err/Info）
  cmd_input / cwd_input / cmd_running / pending_confirm
  tree_roots: Vec<TreeDir{name,path,expanded,loading,error,children}>
  tree_selected / tree_browse / platform / drives / shell_kind
  session_id / term_cwd
```

### 本地文件
- 凭据：`%APPDATA%\GCA Desktop\config.json`（server_url + token）
- agent 日志：`%APPDATA%\GCA Desktop\gca-poc.log`

---

## 6. UI 化状态
已实现（临时可用）：
- 终端页左侧目录树 + shell 切换（cmd/PowerShell）
- 设备详情 sysinfo 表格
- 登录页嗅探结果列表
- 确认横幅（confirmation_required）
- 注册入口（2026-08-06）：登录后比对本机 machineId 与设备列表 → 未注册显示横幅 →
  POST /register {deviceName, machineId, port:3001} → pending 显示确认码 →
  飞书交互卡片或 App 审批 → 设备轮询 GET /ops/:id → approved 即注册完成
- 登录页部署形态动态显示（2026-08-06）：本机检测 agent(3001)/term(3011) 组件 →
  纯控制端（未部署任何组件）隐藏「⚡ 本机模式」按钮
