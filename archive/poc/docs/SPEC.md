# Spec - GCA POC v0.1.0

> 生成日期：2026-07-23
> 基于：架构师 POC 技术方案 + 后端代码结构方案 + QA 验收标准
> 状态：已确认（用户确认三人文档后自动生成）
> ⚠️ **历史文档** — 本文档描述的是 Phase 0 POC 的验收标准（纯 SSE）。
> Streamable HTTP 迁移已于 **2026-07-24** 完成（Phase 1），当前生产环境同时支持
> SSE（`/sse`）和 Streamable HTTP（`/mcp`），Gateway 以 Streamable HTTP 为主。

---

## 1. 产品定义

- **一句话描述**：验证 OpenClaw Gateway + MCP Server 端到端链路能否跑通——设备连接、命令执行、心跳保活
- **目标用户**：GCA 项目开发团队（内部验证）
- **核心问题**：OpenClaw 是否能作为 MCP Host 连接自建 MCP Server，实现 AI 聊天→设备控制的完整链路

## 2. POC 范围（锁定——不在此列表的一律不做）

| 优先级 | 验证点 | 验收标准 | 说明 |
|--------|--------|----------|------|
| P0 | VP1 设备连接 | 4 条 EARS 标准 | MCP Server 注册到 Gateway，SSE 连接建立 |
| P0 | VP2 命令执行 | 5 条 EARS 标准 | 聊天消息→AI 调用 exec→结果返回 |
| P0 | VP3 心跳保活 | 5 条 EARS 标准 | SSE 连接 10 分钟不断线 |
| P1 | BT-01 错误命令 | 边界测试 | 不存在的命令→优雅返回错误 |
| P1 | BT-02 危险命令 | 边界测试 | rm -rf /→拦截，不执行 |
| P1 | BT-03 网络中断 | 边界测试 | 断网 60s 后恢复→重连或优雅报错 |
| P1 | BT-04 命令超时 | 边界测试 | 长时间命令→超时终止 |

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|------------|------|----------|
| file_list Tool | POC 只验证 exec 链路 | Phase 1 |
| sysinfo Tool | POC 只验证 exec 链路 | Phase 1 |
| Streamable HTTP 传输 | SSE 虽已弃用但 OpenClaw 仍支持，POC 先用 SSE | Phase 1 迁移 |
| 完整 approval 对接聊天通道 | POC write 命令只返回 confirmation_required，不实际执行 | Phase 1 |
| 重连机制 | POC 验证基础链路即可 | Phase 1 |
| 多设备并发 | POC 只连一台设备 | Phase 2 |
| Tauri GUI / Android | Phase 1 不做 | Phase 2+ |
| 用户认证 / RBAC | POC 内网可信环境 | Phase 1 |

## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 实际版本 | 锁定原因 |
|----|------|----------|----------|
| 运行时 | Node.js | 22.22.2 LTS (managed) | MCP SDK 要求 >= v18，用 LTS 稳定 |
| MCP SDK | @modelcontextprotocol/sdk | ^1.29.0 | 官方 TypeScript SDK，生产推荐版本 |
| Web 框架 | Express | ^4.21.0 | 成熟稳定，SSE 中间件生态好 |
| Schema 验证 | Zod | ^3.23.0 | MCP SDK 依赖，类型安全 |
| TypeScript | typescript | ^5.6.0 | ES2022 + NodeNext 模块解析 |
| 运行时编译 | tsx | ^4.19.0 | 开发时免编译直接跑 TS |
| OpenClaw Gateway | OpenClaw | 待确认 (VM 上安装) | MCP Host，AI 大脑 |
| 传输方式 | SSE | - | POC 用 SSE，Phase 1 迁移 Streamable HTTP |
| 聊天通道 | 飞书 Bot | - | 用户已有飞书环境 |

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│  Ubuntu VM (OpenClaw Gateway)                            │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  飞书 Bot     │    │  OpenClaw Gateway             │   │
│  │  (Channel)    │←──→│  - MCP Client                 │   │
│  └──────────────┘    │  - Agent Runtime (AI)        │   │
│                      │  - Tool Router               │   │
│                      └──────────┬───────────────────┘   │
└─────────────────────────────────┼───────────────────────┘
                                  │ SSE (GET /sse + POST /messages)
                                  │ http://<本机IP>:3001
┌─────────────────────────────────┼───────────────────────┐
│  Windows 本机 (MCP Server)      │                       │
│  ┌──────────────────────────────▼───────────────────┐   │
│  │  Express Server (port 3001)                       │   │
│  │  ├── GET  /sse        → SSE 事件流 + 会话管理     │   │
│  │  ├── POST /messages  → JSON-RPC 请求路由        │   │
│  │  └── GET  /health    → 健康检查                  │   │
│  │                                                   │   │
│  │  MCP Server (per-connection instance)             │   │
│  │  └── exec Tool                                    │   │
│  │      ├── classifier.ts → 命令分类 (readonly/write/dangerous) │
│  │      ├── approval.ts   → 三级审批决策             │   │
│  │      └── executor.ts    → child_process 执行     │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 5. API 端点清单（锁定）

### MCP Server HTTP 端点

| Method | Path | 功能 | 认证 | 请求体 | 响应体 |
|--------|------|------|------|--------|--------|
| GET | /sse | 建立 SSE 事件流 | 无 | - | text/event-stream |
| POST | /messages?sessionId=xxx | JSON-RPC 请求 | sessionId | JSON-RPC 2.0 | JSON-RPC 2.0 |
| GET | /health | 健康检查 | 无 | - | {status, device, activeSessions, uptime} |

### MCP Tool 定义

| Tool | 描述 | 输入 Schema | 返回 |
|------|------|-------------|------|
| exec | 在设备上执行命令 | {command: string, cwd?: string, timeout?: number} | {status, command, exitCode?, stdout?, stderr?, reason?, note?} |

### exec Tool 返回格式

```json
// readonly 命令 → 自动执行
{ "status": "executed", "command": "ls", "exitCode": 0, "stdout": "file1\nfile2", "stderr": "", "timedOut": false, "truncated": false }

// write 命令 → 需确认（POC 不执行）
{ "status": "confirmation_required", "command": "mkdir test", "reason": "mkdir modifies state", "executed": false }

// dangerous 命令 → 拦截
{ "status": "blocked", "command": "rm -rf /", "reason": "Recursive force delete targeting root or absolute path", "executed": false }
```

## 6. 数据库表清单（锁定）

POC 阶段无数据库。所有状态在内存中（sessions Map）。

## 7. 页面清单（锁定）

POC 阶段无 UI 页面。通过终端 + 聊天界面交互。

## 8. 环境变量配置（锁定）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3001 | MCP Server 监听端口 |
| DEVICE_NAME | home-pc | 设备名称（OpenClaw 中注册的名称） |
| LOG_LEVEL | info | 日志级别：debug/info/warn/error |
| EXEC_TIMEOUT | 30000 | 命令执行超时（毫秒） |
| EXEC_MAX_OUTPUT | 1048576 | 最大输出大小（字节，默认 1MB） |

## 9. 验收标准（锁定——QA 测试时以此为唯一依据）

### VP1: 设备连接（4 条 EARS）

| 编号 | EARS 格式验收标准 | 优先级 |
|------|-------------------|--------|
| VP1-AC1 | When MCP Server 启动并监听 3001 端口，OpenClaw `openclaw mcp list` **必须**显示该设备状态为 connected | P0 |
| VP1-AC2 | When MCP Server 注册到 Gateway，`openclaw mcp probe <device>` **必须**列出 exec tool | P0 |
| VP1-AC3 | When SSE 连接建立，MCP Server 日志 **必须**输出 "SSE client connected" + sessionId | P0 |
| VP1-AC4 | If 网络异常导致连接失败，MCP Server **必须**在日志中记录错误，不静默失败 | P0 |

### VP2: 命令执行（5 条 EARS）

| 编号 | EARS 格式验收标准 | 优先级 |
|------|-------------------|--------|
| VP2-AC1 | When 用户通过飞书发送"在 home-pc 上执行 ls"，AI **必须**解析意图并调用 exec tool | P0 |
| VP2-AC2 | While 命令退出码为 0，stdout **必须**返回到飞书聊天界面 | P0 |
| VP2-AC3 | While 命令退出码非 0，stderr + 退出码 **必须**返回到飞书聊天界面 | P0 |
| VP2-AC4 | If 命令执行超时，系统 **必须**中止执行并返回超时提示 | P0 |
| VP2-AC5 | If AI 无法解析用户意图，系统 **必须**返回澄清提示 | P0 |

### VP3: 心跳保活（5 条 EARS）

| 编号 | EARS 格式验收标准 | 优先级 |
|------|-------------------|--------|
| VP3-AC1 | While SSE 连接处于空闲状态，MCP Server **必须**保持连接不主动断开 | P0 |
| VP3-AC2 | While 连接持续 10 分钟无交互，连接 **必须**保持不断开 | P0 |
| VP3-AC3 | When 10 分钟静默后发送新命令，命令 **必须**正常执行并返回结果 | P0 |
| VP3-AC4 | If 心跳/连接中断，MCP Server **必须**在日志中记录断开事件 | P0 |
| VP3-AC5 | If 连接断开后重新连接，MCP Server **必须**创建新会话并正常工作 | P0 |

### 边界测试

| 编号 | 测试场景 | 预期行为 | P0 条件 |
|------|----------|----------|---------|
| BT-01 | 执行不存在的命令 (如 `nonexistentcmd`) | 退出码非 0 + stderr "command not found" | 系统崩溃/挂起 |
| BT-02 | 执行危险命令 `rm -rf /` | 返回 status: blocked + reason | 命令被执行 |
| BT-03 | 网络中断 60s 后恢复 | 连接断开后有日志记录 | 无限挂起无超时 |
| BT-04 | 长时间运行命令 (如 `sleep 120`) | 30s 后超时终止 | 永久挂起 |

### POC 判定规则

- **3/3 验证点全部通过 + 无 P0 缺陷 → POC PASS**
- **任一验证点失败 或 有 P0 缺陷 → POC FAIL**
- 边界测试不阻断 POC 判定，但发现 P0 缺陷则阻断

## 10. 边界与约束

- POC 仅在可信内网环境运行，不对外暴露
- exec Tool 仅支持 shell 命令，不支持交互式输入
- Windows 用 `cmd.exe /c` 执行，Linux 用 `sh -c`
- 命令输出超过 1MB 自动截断，标记 `truncated: true`
- 命令执行超过 30s 自动终止（可配置，最大 5min）
- SSE 连接每连接创建独立 McpServer 实例（防止响应串台）

## 11. 代码组织门禁（已通过）

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目录分层 | 通过 | transport → tools → services → utils，依赖只向下 |
| 单文件 ≤ 300 行 | 通过 | 最大 168 行 (classifier.ts) |
| 入口零业务逻辑 | 通过 | index.ts 只组装，55 行 |
| 单一职责 | 通过 | 每个文件一个明确职责 |
| 逻辑下沉 service | 通过 | classifier/approval/executor 分离 |

## 12. 内嵌已知坑

> POC 阶段首次开发，暂无历史坑记录。以下为调研发现需注意的点：

| 坑 | 技术栈指纹 | 根因 | 修法 |
|----|------------|------|------|
| OpenClaw 配置格式不确定 | openclaw | 不同版本文档 mcpServers vs mcp.servers | POC 第一步实测两种格式 |
| SSE 已弃用 | mcp-sdk | MCP 2025-03-26 spec 标记 deprecated | POC 可用，Phase 1 迁移 Streamable HTTP |
| 每连接需独立 Server 实例 | mcp-sdk | 共享 McpServer 导致响应串台 | sse-transport.ts 已处理 |
| rm -rf flag 顺序 | classifier | -rf 和 -fr 都要匹配 | 正则已支持两种顺序 |

## 13. 端到端验证步骤

```bash
# 0. 前置条件
# - Windows 本机已安装 Node.js 22 + POC 依赖
# - Ubuntu VM 已安装 OpenClaw + 飞书 Bot
# - 两台机器网络互通

# 1. 启动 POC MCP Server（Windows 本机）
cd D:/Yuzu-GCA-Service/poc
cp .env.example .env
npm run dev
# 预期输出：GCA MCP Server started on port 3001

# 2. 验证健康检查
curl http://localhost:3001/health
# 预期：{"status":"ok","device":"home-pc","activeSessions":0,...}

# 3. 验证 SSE 端点（在 VM 上执行）
curl -N http://<本机IP>:3001/sse
# 预期：event: endpoint\ndata: /messages?sessionId=xxx

# 4. 在 OpenClaw 中注册 MCP Server（在 VM 上执行）
# 编辑 ~/.openclaw/openclaw.json，添加：
# "mcpServers": { "home-pc": { "url": "http://<本机IP>:3001/sse" } }
openclaw mcp list
# 预期：home-pc  connected

# 5. VP1 验证：设备连接
openclaw mcp probe home-pc
# 预期：列出 exec tool

# 6. VP2 验证：命令执行（通过飞书发消息）
# 在飞书 Bot 中发送："在 home-pc 上执行 dir"
# 预期：AI 调用 exec tool，返回目录列表

# 7. VP3 验证：心跳保活
# 等待 10 分钟，不做任何操作
# 10 分钟后通过飞书发送："在 home-pc 上执行 echo hello"
# 预期：命令正常执行，返回 hello

# 8. 边界测试
# BT-01: 发送 "在 home-pc 上执行 nonexistentcmd123"
# BT-02: 发送 "在 home-pc 上执行 rm -rf /"
# BT-03: 断开 VM 网络 60s 后恢复
# BT-04: 发送 "在 home-pc 上执行 sleep 120"

# 9. 汇总结果，判定 POC PASS/FAIL
```

## 14. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-07-23 | 初始版本 | 三人调研产出汇总 | 全部 |
| 2026-07-24 | SSE→Streamable HTTP 迁移 | MCP 2025-03-26 spec SSE deprecated | 传输层，新增 /mcp 端点 |
| 2026-07-25 | Tool 扩展到 20 个 | Phase 1 全功能交付 | 新增 file_*, screenshot, remote_input, power, service 等 |
| 2026-07-26 | Android APK 交付 | P-004 nodejs-mobile 方案 | 新增 android/ 项目，13 tool 可用，7 个 isAndroid 守卫 |
| 2026-07-27 | GcaService SIGTRAP 修复 | V8 InitializeOncePerProcess 双启崩溃 | synchronized 守卫 |
