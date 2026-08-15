# U-012 AI 聊天界面方案对比

> 2026-08-04 · Desktop 内与 Gateway AI 对话的实现路径
> 约束：OpenClaw 只安装在一台设备（VM），方案 C 已淘汰
> **最新进展**：**方案 4 已实现第一版**（`server/src/agents/` 零依赖 WS 适配器 + MCP chat_ai 工具，mock 冒烟测试通过）；双场景授权方案见 [scenario-plan.md](./scenario-plan.md)（流式 SSE 转发 / exec.approval 对接为第二版）

## 需求

- 收发消息（与 AI 对话）
- 审核（高危操作确认码审批）
- 动态码（OTP/确认码）
- 文件收发、读取、生成（复用现有 MCP 工具）

## 方案 A：Desktop 直连 Gateway WebSocket

```
Desktop 聊天界面
  └── WS 长连接 ──▶ OpenClaw Gateway (VM:18789)
        ├── 发消息 → AI 回合
        ├── AI 调设备 MCP 工具（gca-win11/Android）
        ├── AI 回复 → WS 推送回 Desktop
        └── 审核/文件 → Desktop 另调 gca-server MCP
```

**优点：**
- 实时低延迟（WS 长连接，无 CLI 冷启动）
- 会话天然连续（连接即会话）
- 体验最好（打字即达，流式回复）

**缺点：**
- 需实现 WebSocket 客户端（Rust tokio-tungstenite 或前端 ws）
- 需研究 Gateway WS 协议（消息格式/认证/心跳/重连）
- 审核/动态码/文件**不在同一条链路**——Desktop 要同时连 WS（对话）+ HTTP（gca-server 审批）
- Gateway API 变动影响大，维护成本高
- Desktop 要处理连接状态（断线重连/多设备会话路由）

## 方案 B：gca-server MCP chat_ai 工具

```
Desktop 聊天界面
  └── HTTP/MCP ──▶ gca-server (VM:18790)
        ├── chat_ai(message) → gca-server spawn openclaw agent CLI
        │     → CLI 连本机 Gateway → AI 回合 → 返回 JSON
        ├── approve_op(code)  → 审核/动态码（已有）
        ├── list_devices 等管理（已有）
        └── 文件：chat_ai 返回后，文件操作走设备 MCP（已有）
```

**优点：**
- 架构一致——所有交互都走 gca-server MCP（审核/动态码/管理已在这）
- gca-server 与 openclaw 同机（满足约束，天然集成）
- Desktop 零额外依赖、零新协议
- 审核/动态码/文件统一入口，链路清晰

**缺点：**
- CLI 冷启动慢（20-60s 首启，之后 ~2-5s）
- 非流式（等完整回复才显示）
- 会话连续性靠 `--session-key`（同一 key 保持上下文，但每次 spawn 进程）
- 高并发对话会排队（CLI 串行）

## 核心区别

| | A: WS 直连 | B: MCP chat_ai |
|---|---|---|
| **对话通道** | 独立 WS 连接 | 走现有 HTTP/MCP |
| **审核/文件** | 第二条链路（HTTP） | 同一条链路（MCP） |
| **实时性** | 流式、即时 | 整段返回、首启慢 |
| **复杂度** | 高（新协议） | 中（加一个工具） |
| **维护** | Gateway 协议耦合 | CLI 封装在一处 |
| **长期体验** | 最佳 | 可接受（可优化） |

## 建议

**短期：方案 B**（快速落地，审核/动态码/文件全集成）
**长期：方案 A**（如果对话体验成为痛点，升级 WS 直连）

两阶段可平滑过渡：chat_ai 工具的接口保持，底层从 CLI 换成 WS 即可。
