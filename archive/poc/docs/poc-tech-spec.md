# GCA POC 技术方案

> 架构师：高见远 | 日期：2026-07-23 | 状态：已调研，待评审

---

## 一、OpenClaw 调研结论

### 1.1 OpenClaw 是什么

OpenClaw 是一个开源 AI 助手平台（曾用名 Clawdbot / MoltBot，因 Anthropic 法务压力改名），GitHub 星标约 247,000（截至 2026 年 3 月）。核心定位是"运行在用户自有硬件上的 24 小时 AI 管家"。

**技术基线：**

| 维度 | 详情 |
|------|------|
| 运行环境 | Node.js 22+ |
| 安装方式 | `npm i -g openclaw` |
| 架构模式 | Gateway（中心枢纽）+ Nodes（外围设备）+ Channels（聊天通道） |
| 默认端口 | WebSocket 18789（默认绑定 127.0.0.1） |
| 协议基础 | JSON-RPC 2.0（MCP 通信）、WebSocket（设备通信） |
| 开源状态 | 开源，ClawHub 社区生态 |

### 1.2 四层架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Channel Adapters（通道适配层）                  │
│  Telegram / WhatsApp / 飞书 / Slack / Discord / ...     │
│  统一消息格式 → 访问控制 → 会话路由                        │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Gateway Control Plane（网关控制层）             │
│  WebSocket Server (port 18789) · 会话管理 · 状态协调      │
│  访问控制 → 会话解析 → 智能体分发                         │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Agent Runtime（智能体运行时）                   │
│  Pi Agent Core · 上下文组装 · LLM 推理循环 · 工具拦截      │
│  支持模型故障转移（rate limit 时自动切换 provider）        │
├─────────────────────────────────────────────────────────┤
│  Layer 4: Tools & Execution（工具与执行层）               │
│  exec（shell）· browser（CDP）· file · cron · MCP Tools  │
│  Docker 沙箱可选 · allow/deny 策略管控                    │
└─────────────────────────────────────────────────────────┘
```

### 1.3 MCP Host 能力（核心调研结论）

OpenClaw 原生支持 MCP 协议，可以作为 MCP Client 连接外部 MCP Server。这是 GCA 架构的关键基础。

**配置方式：** 在 `~/.openclaw/openclaw.json` 中注册 MCP Server。

**重要发现 — 配置格式存在版本差异：**

| 来源 | 格式 | 示例 |
|------|------|------|
| learnopenclaw.org / claw-crew.com | 顶层 `mcpServers` | `"mcpServers": { "home-pc": { "command": "npx", ... } }` |
| howopenclaw.com / clawdocs.org（较新） | 嵌套 `mcp.servers` | `"mcp": { "servers": { "home-pc": { "url": "..." } } }` |

两种格式均见于社区文档，推测与 OpenClaw 版本演进有关。POC 第一件事就是确认用户 OpenClaw 版本对应的正确格式。

**远程 MCP Server（SSE 传输）配置示例：**

```json
{
  "mcp": {
    "servers": {
      "home-pc": {
        "url": "http://192.168.1.100:3001/sse",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer ${GCA_DEVICE_TOKEN}"
        }
      }
    }
  }
}
```

**本地 MCP Server（stdio 传输）配置示例：**

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
      }
    }
  }
}
```

**CLI 管理命令：**

| 命令 | 作用 |
|------|------|
| `openclaw mcp list` | 列出已配置的 MCP Server 及连接状态 |
| `openclaw mcp probe <name>` | 测试某个 Server，列出其 tools/resources/prompts |
| `openclaw mcp doctor` | 诊断连接问题 |
| `openclaw mcp add <name>` | 交互式添加新 Server |
| `openclaw mcp serve` | 将 OpenClaw 自身暴露为 MCP Server |
| `openclaw tools list --detailed` | 列出智能体可调用的全部工具 |

### 1.4 设备连接的两种路径

调研中发现 OpenClaw 有两种将设备接入 Gateway 的方式：

| 方式 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| **A. 原生 Node 系统** | 设备运行 `openclaw node run --host <gateway> --port 18789`，通过 WebSocket 连接 Gateway，暴露 `system.run` / `system.which` | 零自定义代码；内置心跳/重连/审批/安全模型 | 需在每台设备安装 OpenClaw CLI；能力限于预定义集（system.run, screen, camera 等）；与 OpenClaw 强耦合 |
| **B. 自定义 MCP Server**（用户架构选定） | 设备运行自建 Node.js 进程，作为 MCP Server 通过 SSE 暴露自定义 Tools，在 openclaw.json 中注册 | 完全自定义 Tool 定义；与 OpenClaw 解耦；可移植到任何 MCP Host；匹配 GCA 架构愿景 | 需自行实现 SSE 服务、心跳保活、重连、安全审批 |

**POC 方案选定 Approach B**（自定义 MCP Server），原因：
1. 匹配 GCA 架构愿景——"每台被控设备装一个自建客户端，作为 MCP Server 暴露本机能力"
2. 验证核心假设——自建 MCP Server + OpenClaw Gateway 的可行性
3. 为 Phase 1 提供更大的灵活性——自定义 Tool 定义不受 OpenClaw 预设限制
4. Approach A 可作为 Plan B 降级方案——若 Approach B 在 POC 中遇到无法解决的阻塞

### 1.5 exec 工具与命令执行

OpenClaw 内置 `exec` 工具用于执行 shell 命令，关键参数：

| 参数 | 说明 |
|------|------|
| `command` | Shell 命令（必填） |
| `host` | 执行目标：`auto` / `sandbox` / `gateway` / `node` |
| `node` | 当 `host=node` 时，指定目标节点 ID/名称 |
| `timeout` | 超时秒数（默认 `tools.exec.timeoutSec`） |
| `background` | 是否后台执行 |

**关键认知：** OpenClaw 的 `exec` 工具 `host=node` 模式使用的是 OpenClaw 原生 Node 系统，不走 MCP Server。对于自定义 MCP Server，AI 智能体会直接调用 MCP Server 注册的 Tool（如 `exec_command`），而不是通过 OpenClaw 的 exec 工具路由。这意味着自定义 MCP Server 需要自行实现命令执行逻辑和安全管控。

### 1.6 Telegram 通道接入

OpenClaw 支持 Telegram 作为聊天通道，接入步骤：

1. 通过 @BotFather 创建 Telegram Bot，获取 token
2. 运行 `openclaw configure`，选择 channels → Telegram，配置 token
3. 运行 `openclaw gateway` 启动网关
4. 首次联系需配对审批：`openclaw pairing approve telegram <配对码>`

消息流：Telegram 消息 → Gateway 通道适配器 → 访问控制 → 会话解析 → 智能体推理 → 工具调用（含 MCP Tools） → 响应回 Telegram。

---

## 二、MCP 协议要点

### 2.1 协议概述

Model Context Protocol（MCP）是 Anthropic 创建的开放标准，2025 年底捐赠给 Linux 基金会。定义了 AI 智能体连接外部工具和数据源的统一方式。使用 JSON-RPC 2.0 编码消息。

**三种能力类型：**

| 能力 | 作用 | 示例 |
|------|------|------|
| Tools | 智能体可调用的函数 | `exec_command`, `list_files`, `get_sysinfo` |
| Resources | 智能体可读取的数据 | 配置文件、数据库 schema |
| Prompts | 可复用的提示词模板 | 代码审查清单、bug 报告格式 |

### 2.2 传输方式

| 传输方式 | 适用场景 | 状态 | GCA 选择 |
|----------|----------|------|----------|
| **stdio** | 本地子进程，客户端 spawn 服务端 | 稳定 | 不适用（GCA 需要远程连接） |
| **HTTP + SSE** | 远程服务器，SSE 单向流 + HTTP POST | 已弃用（协议版本 2024-11-05） | **POC 使用** |
| **Streamable HTTP** | 远程服务器，双向 HTTP 流 | 推荐（协议版本 2025-06-18+） | Phase 1 迁移目标 |

**POC 选择 SSE 的原因：**
1. OpenClaw 当前文档中远程 MCP Server 配置均使用 SSE（`"url": "http://...:3001/sse"`, `"transport": "sse"`）
2. SSE 实现更简单，适合 2 天 POC 快速验证
3. 用户架构示例中明确使用 SSE URL

**风险提示：** SSE 传输在 MCP 规范中已标记为弃用。POC 验证通过后，Phase 1 应迁移到 Streamable HTTP。需验证 OpenClaw 是否支持 Streamable HTTP 传输的 MCP Server。

### 2.3 SSE 传输机制

SSE Server 需要两个 HTTP 端点：

```
客户端                              服务端
  │                                   │
  │──── GET /sse (建立 SSE 流) ──────→│  返回 SSE 流，发送 endpoint 事件
  │                                   │  event: endpoint
  │                                   │  data: /messages?sessionId=xxx
  │                                   │
  │──── POST /messages?sessionId=xxx →│  发送 JSON-RPC 请求
  │←──────────────────────────────────│  通过 SSE 流返回 JSON-RPC 响应
  │                                   │
  │←── SSE ping (保活) ───────────────│  定期发送注释行保持连接
  │                                   │
```

- **GET /sse**：建立 SSE 长连接，服务端返回 `endpoint` 事件告知客户端后续 POST 消息的 URL
- **POST /messages**：客户端发送 JSON-RPC 请求（tools/list, tools/call 等）
- **SSE 流**：服务端通过 SSE 流返回 JSON-RPC 响应和通知

### 2.4 Tool 定义格式

使用官方 TypeScript SDK（`@modelcontextprotocol/sdk`）注册 Tool：

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'gca-device-server',
  version: '1.0.0'
});

// 注册 exec_command 工具
server.registerTool(
  'exec_command',
  {
    title: 'Execute Shell Command',
    description: 'Execute a shell command on this device and return stdout/stderr',
    inputSchema: {
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().default(30000).describe('Timeout in ms')
    }
  },
  async ({ command, timeout }) => {
    // 执行逻辑...
    return {
      content: [
        { type: 'text', text: `stdout: ...\nstderr: ...\nexit code: 0` }
      ]
    };
  }
);
```

**Tool 返回格式：**

```typescript
{
  content: [
    { type: 'text', text: '结果文本' },
    // 或 { type: 'image', data: base64String, mimeType: 'image/png' }
  ],
  isError?: boolean  // 可选，标记是否为错误结果
}
```

### 2.5 最小 MCP Server 代码结构（SSE 传输）

基于官方 SDK 的 SSE Server 最小实现：

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { z } from 'zod';

// 1. 创建 MCP Server 实例
const getServer = () => {
  const server = new McpServer({
    name: 'gca-device-server',
    version: '1.0.0'
  });

  server.registerTool('exec_command',
    {
      description: 'Execute a shell command on this device',
      inputSchema: { command: z.string() }
    },
    async ({ command }) => {
      // ... 执行命令 ...
      return { content: [{ type: 'text', text: 'result' }] };
    }
  );
  return server;
};

// 2. 创建 Express 应用
const app = express();
app.use(express.json());

// 3. 会话管理
const transports: Record<string, SSEServerTransport> = {};

// 4. SSE 端点 — 建立 SSE 流
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  transport.onclose = () => { delete transports[transport.sessionId]; };
  const server = getServer();
  await server.connect(transport);
});

// 5. 消息端点 — 接收客户端 JSON-RPC 请求
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (!transport) { res.status(404).send('Session not found'); return; }
  await transport.handlePostMessage(req, res, req.body);
});

// 6. 启动监听
app.listen(3001, () => {
  console.log('GCA MCP Server listening on port 3001');
});
```

---

## 三、POC 测试方案

### 3.1 测试环境

| 角色 | 设备 | 软件 | 网络 |
|------|------|------|------|
| Gateway 端（Server） | 设备 A | OpenClaw Gateway + Telegram Bot | 局域网 / Tailscale |
| Client 端（被控设备） | 设备 B | GCA MCP Server（Node.js） | 与设备 A 同网段可达 |

**前置条件：**
- OpenClaw 已部署在设备 A 上，Telegram Bot 已配置并可收发消息
- 设备 B 已安装 Node.js 22 LTS
- 设备 A 可通过 IP 访问设备 B 的 3001 端口

### 3.2 验证点 1：设备连接 — MCP Server 注册到 Gateway

**目标：** 验证自建 MCP Server 能通过 SSE 传输被 OpenClaw Gateway 识别和连接。

**步骤：**

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1.1 | 在设备 B 启动 MCP Server：`npm run dev`（监听 0.0.0.0:3001） | 控制台输出 "GCA MCP Server listening on port 3001" |
| 1.2 | 在设备 A 编辑 `~/.openclaw/openclaw.json`，添加 MCP Server 配置（见下方配置） | 配置文件保存成功 |
| 1.3 | 在设备 A 重启 Gateway：`openclaw gateway restart` | Gateway 启动日志中出现 MCP 连接信息 |
| 1.4 | 在设备 A 验证连接：`openclaw mcp list` | 输出列表中包含 `home-pc`，状态为 connected |
| 1.5 | 在设备 A 验证工具发现：`openclaw mcp probe home-pc` | 列出 `exec_command` 等 Tool |
| 1.6 | 在设备 A 验证工具加载：`openclaw tools list --detailed` | 智能体可用工具列表中包含 home-pc 的 Tools |

**OpenClaw 配置（需根据实际版本验证格式）：**

```json
{
  "mcp": {
    "servers": {
      "home-pc": {
        "url": "http://<设备B-IP>:3001/sse",
        "transport": "sse"
      }
    }
  }
}
```

**通过标准：**
- `openclaw mcp list` 显示 home-pc 为 connected
- `openclaw mcp probe home-pc` 成功列出 Tools
- 设备 B 的 MCP Server 日志显示有客户端连接

**失败排查：**
- 检查配置格式（`mcp.servers` vs `mcpServers`）
- 检查网络可达性（`curl http://<设备B-IP>:3001/sse` 应返回 SSE 流）
- 运行 `openclaw mcp doctor` 诊断
- 查看日志：`openclaw logs --filter mcp --tail 100`

### 3.3 验证点 2：命令执行 — 通过 Telegram 消息触发 AI 调用 MCP Tool

**目标：** 验证用户通过 Telegram 发送自然语言消息，AI 智能体能自动选择正确的 MCP Server 并调用 Tool 执行命令，返回结果。

**步骤：**

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 2.1 | 确保 Telegram Bot 已配对：`openclaw pairing approve telegram <code>` | 配对成功 |
| 2.2 | 通过 Telegram 向 Bot 发送消息："在 home-pc 上执行 dir 命令"（Windows）或 "在 home-pc 上执行 ls 命令"（Linux/Mac） | 消息发送成功 |
| 2.3 | 等待 AI 响应（通常 5-15 秒） | AI 回复包含命令执行结果（目录列表） |
| 2.4 | 发送第二条消息："在 home-pc 上查看当前目录有哪些文件" | AI 理解意图，调用 exec_command 执行 ls/dir，返回文件列表 |
| 2.5 | 发送第三条消息（测试错误处理）："在 home-pc 上执行一个不存在的命令 xyz123" | AI 回复包含错误信息（command not found 或 exit code 非 0） |

**数据流验证：**

```
Telegram 消息 → Gateway 通道适配器 → 访问控制（配对校验）
→ 会话解析 → 智能体推理（LLM 决定调用 home-pc 的 exec_command Tool）
→ MCP Client 发送 tools/call JSON-RPC 请求到 home-pc MCP Server
→ MCP Server 执行 shell 命令 → 返回 stdout/stderr
→ 智能体格式化结果 → 通过 Telegram 通道返回用户
```

**通过标准：**
- AI 能正确识别目标设备（home-pc）和操作意图（执行命令）
- 命令在设备 B 上实际执行（设备 B 日志可见执行记录）
- 执行结果通过 Telegram 返回给用户
- 错误命令能正确返回错误信息而非静默失败

### 3.4 验证点 3：心跳保活 — 连接保持 10 分钟不断线

**目标：** 验证 SSE 长连接在无活动 10 分钟后仍能保持，且后续命令仍可正常执行。

**背景：** SSE 连接可能因以下原因断开：
- 网络中间设备的空闲超时（如 NAT、负载均衡器默认 60-300 秒）
- HTTP 代理的连接超时
- 操作系统 TCP keepalive 超时

**保活方案：** MCP Server 侧定期发送 SSE 注释行（`: ping\n\n`）作为心跳。SSE 规范允许注释行，客户端会忽略但不断开。

**步骤：**

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 3.1 | 确认验证点 1 通过（连接已建立） | home-pc 显示 connected |
| 3.2 | 记录连接开始时间，不做任何操作 | — |
| 3.3 | 等待 5 分钟，检查连接状态：`openclaw mcp list` | home-pc 仍为 connected |
| 3.4 | 等待至 10 分钟，再次检查：`openclaw mcp list` | home-pc 仍为 connected |
| 3.5 | 10 分钟后通过 Telegram 发送命令："在 home-pc 上执行 echo heartbeat-ok" | AI 回复 "heartbeat-ok"，命令正常执行 |
| 3.6 | 检查设备 B 的 MCP Server 日志 | 日志显示 SSE 心跳持续发送，无断线重连记录 |

**心跳实现（MCP Server 侧）：**

```typescript
// 在 SSE 连接建立后启动心跳
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);

  // 心跳：每 30 秒发送 SSE 注释行
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  transport.onclose = () => {
    clearInterval(heartbeat);
    delete transports[transport.sessionId];
  };

  const server = getServer();
  await server.connect(transport);
});
```

**通过标准：**
- 10 分钟空闲后连接仍为 connected
- 空闲后发送的命令能正常执行并返回结果
- MCP Server 日志无异常断线记录
- 心跳间隔 30 秒（低于常见 NAT 超时 60 秒）

**失败场景与应对：**

| 失败场景 | 可能原因 | 应对方案 |
|----------|----------|----------|
| 连接在 60 秒后断开 | NAT/防火墙空闲超时 | 缩短心跳间隔至 15 秒 |
| 连接在 5 分钟后断开 | 代理/负载均衡超时 | 检查中间网络设备配置 |
| 命令执行超时 | exec timeout 设置过短 | 调整 EXEC_TIMEOUT 环境变量 |
| 重连后 Session 丢失 | SSEServerTransport 未持久化 session | POC 可接受；Phase 1 实现断线重连 |

---

## 四、技术选型结论

### 4.1 技术栈选型矩阵

| 维度 | 选型 | 理由 |
|------|------|------|
| **运行时** | Node.js 22 LTS | OpenClaw 要求 22+；LTS 保证稳定性；团队熟悉 |
| **MCP SDK** | `@modelcontextprotocol/sdk` ^1.29.0 | 官方 TypeScript SDK；与 OpenClaw MCP Client 协议兼容；社区生态最大 |
| **Web 框架** | Express 4 | SDK 官方示例使用 Express；生态成熟；POC 够用 |
| **Schema 验证** | Zod 3 | SDK 的 `registerTool` 原生使用 Zod 定义 inputSchema；类型安全 |
| **传输方式** | HTTP + SSE（POC）→ Streamable HTTP（Phase 1） | SSE 是 OpenClaw 当前支持的远程传输；Streamable HTTP 是 MCP 规范推荐方向 |
| **日志** | 自建轻量 logger（已有 `src/utils/logger.ts`） | 写 stderr 不干扰 stdout（MCP JSON-RPC 协议要求 stdout 纯净）；POC 不需要 pino/winston |
| **进程管理** | PM2 或 systemd（Phase 1） | POC 阶段用 `npm run dev`（tsx 直接运行）即可 |

### 4.2 依赖清单

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "express": "^4.21.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

### 4.3 POC 代码结构建议

```
poc/
├── package.json
├── tsconfig.json
├── .env.example
├── docs/
│   └── poc-tech-spec.md        ← 本文档
├── src/
│   ├── index.ts                ← 入口：读取配置、启动 Express + MCP Server
│   ├── server.ts               ← MCP Server 实例创建、Tool 注册
│   ├── transport/
│   │   └── sse.ts              ← SSE 传输设置、会话管理、心跳保活
│   ├── tools/
│   │   └── exec/
│   │       └── index.ts        ← exec_command Tool 实现
│   └── utils/
│       └── logger.ts           ← 已有，结构化日志
└── tests/
    ├── connection.test.ts      ← 验证点 1 测试
    ├── exec.test.ts            ← 验证点 2 测试
    └── heartbeat.test.ts       ← 验证点 3 测试
```

**文件组织约束（遵循代码规范）：**
- 单文件不超过 300 行
- 单一职责：每个文件只做一件事
- 入口文件（index.ts）只做装配，不包含业务逻辑
- 按资源分包：tools/ 按功能分子目录

### 4.4 POC Tool 清单（最小集）

基于可行性分析文档中"Phase 1 砍到 3 个 Tool"的决策，POC 只实现 1 个核心 Tool 验证链路：

| Tool 名称 | 输入 | 输出 | 说明 |
|-----------|------|------|------|
| `exec_command` | `command: string`, `timeout?: number` | `stdout`, `stderr`, `exitCode` | 执行 shell 命令，POC 核心验证 Tool |

Phase 1 再扩展 `list_files` 和 `get_sysinfo`。

---

## 五、风险与注意事项

### 5.1 高风险项

| 风险 | 等级 | 影响 | 缓解方案 |
|------|------|------|----------|
| **OpenClaw 配置格式不确定** | 高 | MCP Server 可能无法注册 | POC 第一步用两种格式都试一遍；查看 `openclaw --version` 和官方 release notes 确认 |
| **SSE 传输已弃用** | 高 | 未来 OpenClaw 版本可能停止支持 SSE | POC 用 SSE 验证链路；Phase 1 迁移到 Streamable HTTP；持续关注 OpenClaw 版本更新 |
| **exec 命令安全风险** | 高 | 任意命令执行可能导致设备被入侵 | POC 仅在可信内网环境测试；MCP Server 添加简单的命令白名单/黑名单；Phase 1 实现完整的 approval 机制 |
| **OpenClaw 版本未知** | 中 | 不同版本 MCP 支持程度不同 | POC 前确认 `openclaw --version`；查看 changelog 中 MCP 相关变更 |

### 5.2 中风险项

| 风险 | 等级 | 影响 | 缓解方案 |
|------|------|------|----------|
| **网络环境差异** | 中 | Tailscale / NAT / 防火墙可能阻断 SSE | 确保设备间 IP 直连可达；`curl` 测试 SSE 端点 |
| **AI 模型能力** | 中 | 弱模型可能无法正确选择设备和 Tool | POC 使用 GPT-4o 或 Claude；测试不同表述方式的识别率 |
| **SSE 会话管理** | 中 | 断线后 session 丢失，需手动重连 | POC 可接受单次连接；记录断线频率和原因；Phase 1 实现自动重连 |
| **跨平台命令差异** | 中 | Windows 的 `dir` vs Linux 的 `ls` | exec_command 直接透传给系统 shell；AI 负责选择正确命令 |

### 5.3 P0 规则遵守

| 规则 | 遵守情况 |
|------|----------|
| 禁止 emoji 作为功能图标 | 本文档无 emoji 图标；Tool 名称使用蛇形命名（`exec_command`） |
| 禁止紫色到粉色渐变方案 | 本文档为技术方案，不涉及 UI 设计 |
| 禁止空洞占位文案 | 所有内容基于联网调研，附具体步骤和代码示例 |

### 5.4 POC 验收标准总结

| 验证点 | 通过标准 | 验证方法 |
|--------|----------|----------|
| 设备连接 | `openclaw mcp list` 显示 connected | CLI 命令 |
| 命令执行 | Telegram 消息触发命令，结果返回 | 端到端手动测试 |
| 心跳保活 | 10 分钟空闲后连接不断、命令可执行 | 定时检查 + 延迟命令测试 |

### 5.5 POC 后的决策点

POC 通过后的下一步决策（提交给项目总监）：

1. **是否进入 Phase 1 开发？** — 三个验证点全部通过则放行
2. **传输方式确认** — SSE 是否满足需求，还是直接上 Streamable HTTP
3. **安全方案细化** — exec approval 机制的具体实现方案
4. **Tool 扩展计划** — Phase 1 的 exec + file_list + sysinfo 三个 Tool 的优先级和接口定义
5. **多设备测试** — POC 只测 1 台被控设备，Phase 1 需验证多设备路由

---

## 附录 A：OpenClaw 关键文档链接

| 文档 | URL |
|------|-----|
| 官方文档（中文） | https://docs.openclaw.ai/zh-CN |
| 远程访问 | https://docs.openclaw.ai/zh-CN/gateway/remote |
| 节点系统 | https://docs.openclaw.ai/zh-CN/cli/nodes |
| 节点主机 | https://docs.openclaw.ai/zh-CN/cli/node |
| exec 工具 | https://docs.openclaw.ai/zh-CN/tools/exec |
| MCP 参考 | https://www.howopenclaw.com/reference/mcp |
| MCP Servers 指南 | http://clawdocs.org/guides/mcp-servers |

## 附录 B：MCP 协议关键文档链接

| 文档 | URL |
|------|-----|
| MCP 官方规范 | https://modelcontextprotocol.io/specification |
| 传输规范 | https://modelcontextprotocol.io/specification/2025-06-18/basic/transports |
| TypeScript SDK | https://ts.sdk.modelcontextprotocol.io/server.html |
| SDK GitHub | https://github.com/modelcontextprotocol/typescript-sdk |
| SSE Server 示例 | https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleSseServer.ts |

## 附录 C：ADR 记录

### ADR-001: 使用 SSE 传输而非 Streamable HTTP

- **状态：** Accepted (2026-07-23)
- **背景：** GCA 需要远程 MCP Server 传输方式。MCP 规范推荐 Streamable HTTP，但 SSE 仍被广泛支持。
- **决策：** POC 阶段使用 SSE 传输。原因：(1) OpenClaw 当前文档中远程 MCP 配置均使用 SSE；(2) SSE 实现更简单，适合 2 天 POC；(3) 用户架构示例使用 SSE URL。
- **后果：**
  - 正面：快速验证核心链路，降低 POC 复杂度
  - 负面：SSE 已弃用，Phase 1 需迁移到 Streamable HTTP；需验证 OpenClaw 对 Streamable HTTP 的支持程度
- **关联：** ADR-002

### ADR-002: 使用自定义 MCP Server 而非 OpenClaw 原生 Node 系统

- **状态：** Accepted (2026-07-23)
- **背景：** OpenClaw 提供两种设备接入方式——原生 Node 系统（`openclaw node run`）和自定义 MCP Server。
- **决策：** 选择自定义 MCP Server 方案。原因：(1) 匹配 GCA 架构愿景；(2) 自定义 Tool 定义更灵活；(3) 与 OpenClaw 解耦，可移植。
- **后果：**
  - 正面：架构自主可控，Tool 定义不受限，匹配产品愿景
  - 负面：需自行实现心跳、重连、安全审批；开发量大于原生 Node 系统
- **关联：** ADR-001

### ADR-003: POC 仅实现 exec_command 单个 Tool

- **状态：** Accepted (2026-07-23)
- **背景：** 可行性分析建议 Phase 1 实现 exec + file_list + sysinfo 三个 Tool。POC 需要最小化验证。
- **决策：** POC 只实现 exec_command，验证完整链路（设备连接 → AI 调用 → 命令执行 → 结果返回 → 心跳保活）。
- **后果：**
  - 正面：2 天内可完成验证，聚焦核心链路
  - 负面：file_list 和 sysinfo 的可行性未在 POC 中验证（但 exec_command 是最复杂的，如果它可行，其他两个更简单）
- **关联：** 无
