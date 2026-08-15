# GCA 架构与部署规范（扩展友好）

> 2026-08-06 定稿（取代 2026-07-23 愿景版）· 新增组件/工具/端点时按本规范扩展
> 接口细节见 api.md · 跨会话恢复见 project-status.md

## 1. 组件规范（独立部署，任意组合）

| 组件 | 产物 | 部署位置 | 职责 | 端口 | 端点 |
|---|---|---|---|---|---|
| 控制端 | `gca-desktop.exe` | 任何 Windows 电脑 | UI：登录/终端/详情/AI 聊天/管理 | — | 客户端 |
| AI 通道 | `gca-agent.exe` | 被控设备 | 标准 MCP server：20 工具 + 审批 + consent | 3001 | `/health` `/mcp` `/transfer/{token}` |
| 人终端 | `gca-term.exe` | 被控设备 | 终端服务：ConPTY 真终端（免审批）+ 目录 + 平台 + 审计 | 3011 | `/health` `/term/*` |
| 控制面 | `gca-server` | VM/服务器（Node） | 注册/审批流/设备管理/代理/推送/审计 | 18790 | REST + `/device/:name/(mcp\|term)` |

**部署原则**：
- 三个 Windows 组件（desktop/agent/term）**互相独立**——单装/两两/全装均可，互不依赖
- agent 与 term 端口约定：`agent 端口 + 10 = term 端口`（3001→3011）——gca-server 代理按此映射
- 设备侧可只部署 agent（纯 AI 被控）或只部署 term（纯人终端）或都装（完整被控）
- **mDNS 发现（INT-004）**：gca-server 发布 `_gca-server._tcp.local.`（UDP 组播 224.0.0.251:5353，TTL 120s，60s 重发；应答带 SRV 端口 18790）；客户端 PTR 查询带 QU 位（QCLASS=0x8001）→ 单播应答。desktop 逐本机 IP 钉组播出口发查询（Windows 默认组播接口可能落虚拟网卡——实测 172.29 WSL 网卡不出物理网），无应答回退全网段端口扫描（scan.rs，保留作 fallback）
- **审计集中（INT-005）**：agent/TS 客户端 `GCA_AUDIT_PUSH=1` 时把操作日志（审批/执行/拦截/免确认传输）POST 到 `GCA_SERVER_URL/audit`（desktop 登录后注入 agent/term 环境），默认本地留痕；server `/audit` 环形缓冲 1000 条 + 面板审计页

## 2. 部署形态矩阵

| 形态 | 勾选组件 | 场景 |
|---|---|---|
| 全量 | 桌面 + AI + 远控（+ VM gca-server） | 完整：控制 + 被控 + AI |
| 单机生产 | 桌面 + AI + 远控（同机 OpenClaw，无 gca-server） | OpenClaw 控制本机 + 人终端；审批走本地 confirm |
| 纯控制端 | 只桌面 | 控制远程设备（连远程 gca-server） |
| 纯被控（AI） | 只 agent | 无人值守设备 |
| Android（仅 agent） | Android agent（Rust，JNI 直启） | 无人值守设备（默认 3003 端口，env 经 JNI set_var 注入——Android 无自定义进程 env；无 term） |
| 纯人终端 | 只 term | 只需人远程操作 |

**登录页动态逻辑**（gca-desktop）：
- 检测本机 127.0.0.1:3001/3011 → 有 agent/term → 显示并默认选中「本机模式」
- 无 agent/term（纯控制端）→ 隐藏本机模式，直接服务器连接
- 「连接远程服务器」始终可用（连远程 gca-server）

## 3. 命名规范

**环境变量（统一 `GCA_` 前缀）**：
```
agent: GCA_MCP_TOKEN / GCA_DEVICE_TOKEN（S1，2026-08-12）/ GCA_AGENT_PORT(3001) / GCA_DEVICE_NAME / GCA_MACHINE_ID
term:  GCA_TERM_TOKEN（支持独立） / GCA_TERM_PORT(3011) / GCA_TERM_IDLE_MS(300000)
```
- agent 与 term **支持 token 隔离**（C9 更正，2026-08-12 审查）：`GCA_TERM_TOKEN` 独立配置；桌面端默认注入同值（`GCA_TERM_TOKEN` 回退 `GCA_MCP_TOKEN`），完整隔离二期轮换
- `GCA_DEVICE_TOKEN`：设备自铸 token（S1）——设备 → gca-server 认证（heartbeat/audit/clipboard/ops），与 owner 管理 token 彻底分离；未显式配置时回退 `GCA_MCP_TOKEN`（过渡）
- `GCA_TERM_IDLE_MS`：会话空闲回收时间（默认 300000ms = 5 分钟）

**端点规范**：
- agent：`/health` `/mcp`（MCP JSON-RPC）`/transfer/{token}`（票据下载）
- term（真终端模型，2026-08-06 起）：`/health` `/term/sse?cols=&rows=`（SSE 输出流）`/term/input`（base64 键盘字节）`/term/resize` `/term/shell` `/term/ls` `/term/sysinfo`（旧 exec/interrupt/close 废弃 404）
- gca-server：REST（见 api.md）+ `/heartbeat`（设备 IP 更新）+ `/device/:name/mcp`（→ 设备 3001/mcp）+ `/device/:name/term/*`（→ 设备 3011/term/*）

**认证**：
- agent/term：Bearer 各自 token（未配置 token = 开放模式，仅限开发）
- gca-server：Bearer server token

## 4. 审批与门控（按使用者隔离）

| 通道 | 审批 | 会话 |
|---|---|---|
| AI（agent /mcp） | exec 三级别（只读放行/写确认/危险阻止）+ consent 窗口（截图/键鼠） | 无状态 |
| 人（term /term/*） | 免审批（人输入即授权） | 常驻 ConPTY 会话（cd 连续） |

- 审计：term 命令本地记录；agent 工具调用 + term 命令均可上报 gca-server `/audit` 集中

## 5. 扩展指南（后期加内容）

**新增一个工具（agent）**：
1. `agent/src/tools/xxx.rs`：`def()`（name/description/schema）+ `run()`（返回 `Result<Value, String>`）
2. `tools/mod.rs`：`pub mod xxx;` + `list()` 注册 + `call()` 分发
3. 需审批 → run 里 `pending::push`；只读 → 直接执行；测试加 `#[cfg(test)]`

**新增一个 term 端点**：
1. `agent/src/bin/gca-term.rs` 的 `term_handle` 加路径匹配
2. 文档：api.md 第 4 节 + 本文件端点表

**新增一个组件/进程**：
1. 命名 `gca-xxx.exe`（Windows）或独立服务
2. 端口避开约定段（3001/3011/18790）
3. 环境变量 `GCA_XXX_*`
4. 文档：组件表 + 部署形态矩阵 + api.md

**新增一个 gca-server REST 端点**：
1. `server/src/gca-server.ts` 路由区（`url.match` 模式）
2. 需 Bearer → `authorized(req)` 检查
3. 文档：api.md 第 2 节

## 6. 数据面（跨设备文件传输）

- file_serve：确认后铸一次性票据（5 分钟、单次、绑定文件）
- 下载：`http://设备IP:3001/transfer/{token}`（票据即授权，无 Bearer）
- file_fetch：票据 URL 免确认直接下载；外部 http 需确认
- 字节流设备间直连，控制面只见 URL + token
