# U-012 双场景授权方案（场景方案）

> 2026-08-04 · 基于**方案 4**（gca-server 常驻 Gateway WS 连接 + AgentAdapter）落地的双场景使用方案
> 场景来源：用户口述——电脑使用 / 手机使用
> 前置条件：方案 4 架构（Desktop/手机统一界面 → gca-server 控制面 → 设备 MCP + Agent 适配层）

## 一、两个场景定义

### 场景 1：电脑使用
用户在**电脑（Desktop）**上与 AI 对话，指挥 AI 操作电脑/其他设备。遇到授权时：
- **高风险操作（动态码授权）**：AI 暂停，等待**手机令牌端**授权（手机收到确认码 → 用户回复码 → AI 继续执行）
- **确认类操作**：除 Desktop 前端弹确认框外，**手机上也能确认**（双通道）

### 场景 2：手机使用
用户在**手机（Android GCA app）**上与 AI 对话。本机即审批端：
- 确认类操作**本机弹框直接确认**
- **不用令牌端**——不存在「另一台设备授权」的环节（执行端 = 审批端 = 手机）

## 二、场景 1 流程（电脑）

### 2.1 动态码授权（高风险/首次操作）

```
Desktop 聊天界面
   │ ① 用户下指令：「帮我把 D:\ 下所有 .log 文件删掉」
   ▼
gca-server 常驻 Gateway WS 连接（协议 v4，会话即用）
   │ ② AI 判断高危 → 调设备 MCP 高危工具
   ▼
设备 gca-win11 (client)
   │ ③ POST /ops/request { operation: 'file_delete' }   ← 已有
   ▼
gca-server ops.ts
   │ ④ 生成 6 位动态码（TTL 5 分钟），push 到手机        ← 已有
   ▼
手机令牌端（飞书/微信收到确认码；未来 Android 令牌界面）
   │ ⑤ 用户回复码：「784201」                            ← 已有
   ▼
AI（Gateway 会话）
   │ ⑥ 识别确认码 → 调 gca-server approve_op(code)       ← 已有
   ▼
gca-server
   │ ⑦ 状态 pending → approved，设备轮询 GET /ops/:id    ← 已有
   ▼
设备 client → ⑦' 继续执行 → 结果回 gca-server → Desktop 显示
```

**关键点**：①② 之间 AI 的「暂停」由 Gateway 会话天然实现——AI 回合中工具调用未完成前不返回最终回复；用户回复码后 AI 继续同一 sessionKey 的下一个回合（chat.send 按 sessionKey 路由）。冷启动问题不存在——Gateway 本就常驻，gca-server 一条 WS 连接即用。

### 2.2 确认类操作（双通道）

```
设备高危工具触发 /ops/request（确认类，如「重启服务」「卸载软件」）
   │
   ├─ 通道 A（Desktop 前端）   ← 已有：本机确认框，直接 approve
   │      Desktop 弹框「确认重启 service?」→ 用户点确认 → 设备继续
   │
   └─ 通道 B（手机令牌端）     ← 已有链路：回码 → AI approve_op
          手机收到 push「设备请求 重启服务，确认码: 482913」
          用户回码 → AI 调 approve_op → 设备继续
```

两条通道最终都收敛到 `approve_op`（或本机 approve），**审批状态唯一**（PendingOp.status），不会出现两端不一致。

## 三、场景 2 流程（手机）

```
Android GCA app（聊天界面）
   │ ① 用户下指令：「把相册里今天拍的照片发我」
   ▼
gca-server 会话池
   │ ② AI 调本机（Android）MCP 工具（文件读取）
   ▼
Android client
   │ ③ 确认类操作 → 本机弹确认框（local confirm）        ← 已有机制
   │    用户手机直接点确认 → 继续执行
   ▼
结果 → Android 界面显示；文件直接回传
```

**不需要** /ops/request + 动态码环节——审批端与执行端是同一台手机，本机确认即审批。

## 四、与现有机制的映射（方案 3）

| 环节 | 现有机制 | 状态 |
|---|---|---|
| 动态码生成/审批/过期 | `server/src/ops.ts` PendingOp（code/status/deviceIp/machineId/devicePort） | ✅ 已有 |
| AI 审批入口 | `server/src/mcp.ts` approve_op 工具 | ✅ 已有 |
| 推送令牌端 | `server/src/mcp.ts` push_message + `push.ts`（飞书/微信） | ✅ 已有 |
| 设备轮询审批结果 | client `/ops/:id` 轮询（power/service handler） | ✅ 已有 |
| 本机确认（场景 2） | client `confirm/handler.ts` 本地确认 | ✅ 已有 |
| Desktop 前端确认 | Desktop 弹框 → 设备本地 approve | ✅ 已有 |
| **AI 对话通道** | **gca-server 常驻 Gateway WS 连接（chat.send + sessionKey 路由，协议 v4）** | ❌ 需新增 |
| 手机聊天界面 | Android GCA app 的聊天 UI | ❌ 需新增 |
| 手机令牌端独立界面 | 当前借道飞书/微信；独立 Android 审批界面（pending 列表 + 确认/拒绝） | 🔶 可选（P2） |

## 五、授权类型总表

| 类型 | 触发 | 场景 1 通道 | 场景 2 通道 |
|---|---|---|---|
| 动态码授权（高风险） | AI 判断或规则命中 | 手机令牌端回码 → AI approve_op | 不适用（本机=审批端） |
| 确认类 | 确认工具调用 | Desktop 弹框 **或** 手机回码（双通道） | 本机弹框 |

## 六、新增改动清单（确认后进入实现）

1. **gca-server 常驻 WS 连接**：`chat_ai(message, sessionKey)` 工具 + 一条常驻 Gateway 连接（握手/心跳/重连/device token），多会话按 sessionKey 路由
2. **AgentAdapter 接口**：`interface AgentAdapter { chat(msg, sessionKey): AsyncIterable<string> }`（流式）——OpenClaw 实现走 WS，Hermes 实现走 HTTP+SSE（OpenAI 兼容 API），各用各最自然的方式；换底座只加一个实现（满足「GCA 不是为一个平台定制的」）
3. **手机聊天界面**（场景 2）：Android 端复用聊天 UI（与 Desktop 同一套界面，走同一 gca-server 入口）
4. **审批状态推送**（可选）：确认类操作从「轮询」升级为「gca-server 主动推送审批结果」，两端 UI 实时刷新

## 七、OpenClaw 协议核实与设计优化（2026-08-04 二次调研）

基于 OpenClaw Gateway 官方协议文档核实，方案 4 确认可行并进一步简化：

### 协议事实
- **WS 是唯一控制面**：CLI/Web UI/移动端/节点全部以 WS 连 Gateway——方案 3 的 `spawn CLI` 是绕路（CLI 本身也是 WS 客户端），彻底出局
- **聊天**：`chat.send(sessionKey, message)` → runId；`agent.wait(runId)` 等结果；`message.delta` / `message.complete` 事件 = **流式**
- **会话**：Gateway 侧管理（sessions.list/history），按 sessionKey 路由——**一条 WS 连接可服务所有会话**
- **审批**：`exec.approval.requested` 广播 + `exec.approval.resolve`（需 operator.approvals scope）——Gateway 原生审批
- **认证**：`OPENCLAW_GATEWAY_TOKEN` 或设备配对（本地连接可 auto-approve）；握手返回 deviceToken 需持久化
- **版本化**：minProtocol/maxProtocol 协商（当前 v4）；官方 npm 包 `@openclaw/gateway-client` + `@openclaw/gateway-protocol`

### 设计优化（相对原草案）
1. **「会话池」→「一条常驻连接」**：连接管理（握手/心跳/重连/device token）+ 多会话 sessionKey 路由，比进程池简单一个量级
2. **流式实锤**：message.delta → gca-server SSE 转发 → Desktop/手机
3. **审批两级分层**：
   - GCA PendingOp 层（现有）：设备 MCP 工具高危操作（动态码/双通道）——不变
   - Gateway exec.approval 层（可选对接）：OpenClaw 原生节点操作审批时，gca-server 以 operator.approvals 角色响应
4. **实现方式（已定：零依赖自写）**：`server/src/agents/`（adapter.ts 接口 + openclaw.ts 实现 + index.ts 注册）——Node 原生 WebSocket + 手写帧协议，基于官方 protocol.md + gateway-client 源码核实（payload v3 签名格式）。已通过 `server/scripts/mock-gateway.mjs` 模拟 Gateway 本地冒烟测试：握手/chat.send/agent.wait/断线重连全通过

### 实现记录（2026-08-04 完成第一版）
- `server/src/agents/adapter.ts` — AgentAdapter 接口（chat 非流式 v1，onEvent 预留流式/审批）
- `server/src/agents/openclaw.ts` — OpenClawWsAdapter：connect.challenge → connect（backend operator，含 ed25519 设备身份签名 payload v3 降级路径）→ hello-ok；请求-响应 id 映射；tick 心跳监控 + 指数退避重连；deviceToken 持久化（~/.gca-server/agent-key.json）
- `server/src/agents/index.ts` — getAgent() 单例（未来 config 切 Hermes）
- `server/src/config.ts` — gateway.url/token 从 env（OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN）或 ~/.openclaw/openclaw.json（含 gateway.auth.token）读取，无硬编码
- `server/src/mcp.ts` — 新增 chat_ai 工具（message + sessionKey）

### 真机联调（2026-08-04 VM <网关IP> 通过）
- 部署：`~/gca-server/`（dist 同步 + `systemctl --user restart gca-server`，服务 gca-server.service）
- Gateway 认证实测：`gateway.auth.mode=token` —— **backend + 共享 token + loopback 可省略 device**（官方豁免路径）；无 token 时才走 device 配对（payload v3 签名）
- 回复获取实测：`agent.wait` 只返回 run 状态快照（{runId,status,endedAt}）→ 改为**事件驱动**：收集 `chat` 事件（delta 累积 deltaText，final 取 message），超时返回累积文本
- 会话连续性：同一 sessionKey 上下文保持 ✓（「我刚才问了你什么」能答出上轮内容）
- mock-gateway.mjs 已同步补发 chat delta/final 事件（本地回归可复现）
- 踩坑：device identity mismatch（新 device 未配对）→ token 豁免路径修复；agent.wait 无文本 → 事件驱动修复
