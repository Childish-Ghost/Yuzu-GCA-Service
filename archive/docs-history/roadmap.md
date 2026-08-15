# 实施路线图

> 2026-07-23 修订：采纳可行性分析建议，从原 5 阶段 28 周计划收窄为渐进验证路线

| 指标 | 数值 |
|------|------|
| 当前阶段 | **Phase 3 — 多设备 + 平台扩展（Android 已交付，13/20 Tool）** |
| 拿到可用产品 | 12 周（Phase 0-3） |
| 远期愿景 | 原 5 阶段计划（见文末附录） |

::: tip 核心原则：先跑通，再完善
Phase 1 的唯一目标是验证「用户发消息 → AI 理解 → MCP 调用 → 设备执行 → 返回结果」这条链路。

3 个 Tool 足够证明链路通畅。先用 3 个 Tool 跑通 2 周，再花 4 周扩到 10 个。**不要一开始就铺 36 个。**
:::

## Phase 0：技术验证 POC（2 天）— 代码已完成

**目标：验证 OpenClaw + MCP 最小闭环，跑不通就换方案**

1. 手动注册一个最简 MCP Server 到 OpenClaw Gateway
2. 通过飞书 Bot 发消息 → AI 调用 `exec` 执行命令 → 返回结果
3. 验证 SSE 连接 10 分钟心跳不断线
4. 边界测试：错误命令优雅报错、危险命令拦截、断网恢复、超时终止

**当前状态：**

| 项目 | 状态 |
|------|------|
| POC 代码（poc/，Node.js 22 + MCP SDK 1.29） | ✅ 完成 |
| 单元测试 185 个 + E2E 19 个 | ✅ 全部通过 |
| Ubuntu VM 部署 OpenClaw Gateway | ✅ 生产运行 |
| 飞书 Bot 联调验证 | ✅ 已通过 |
| Windows 设备 (<本机IP>:3001) | ✅ 20 Tool 全功能 |
| Linux VM 设备 (<网关IP>:3002) | ✅ 20 Tool 全功能 |
| Android 设备 (<Android设备IP>:3003) | ✅ 13/20 Tool，7 个 isAndroid 守卫 |

**技术锚定：** exec 单 Tool + 三级审批已实现（readonly 自动执行 / write 返回 confirmation_required / dangerous 拦截）。POC 用 SSE 传输，Phase 1 迁移 Streamable HTTP。

::: tip 交付物与验收
飞书发 `dir` 类只读命令 → 收到执行结果。验收标准见 `poc/docs/SPEC.md`（EARS 标准 14 条）。
:::

::: warning Go / No-Go 决策点（POC 验收后立即做）
- **Go（验收通过）** → 锁定 OpenClaw 版本号，进入 Phase 1
- **No-Go（核心链路跑不通）** → 启动 fallback：评估自建极简 MCP Host。POC 已证明 MCP Server 侧（分类/审批/执行/SSE 链路）没有问题，Host 侧替代成本可控；已完成的 POC 代码与测试资产全部保留复用
:::

## Phase 1：最小 MVP（2 周）

**目标：通过聊天通道控制一台 Windows 设备**

1. POC 基础上补齐 3 个 Tool：`exec` + `file_list` + `sysinfo`
2. 客户端定型为 **Node.js CLI**（`npx gca-cli start`），无 GUI
3. SSE → Streamable HTTP 传输迁移
4. write 命令的三级审批对接到聊天通道（回复"允许"完成确认）
5. 错误恢复：WS 自动重连（指数退避 1s→2s→4s→...→60s）、请求超时 + 重试
6. 基础日志：pino 结构化日志，客户端日志上报 Gateway
7. 锁定 OpenClaw 版本号，所有交互封装适配层

::: tip 验收标准（全部通过才算完成）
① 飞书发 "列出电脑文件" → 收到文件列表
② 飞书发 "执行 dir" → 收到结果
③ 飞书发 "看看磁盘满了没" → AI 调 sysinfo 返回磁盘信息
④ 客户端重启后自动重连
:::

**明确不做：** 远程桌面、Android 客户端、AI 操控、外网访问、多设备、Tauri GUI。

## Phase 2：能力扩展（4 周）

**目标：扩展到 10 个核心 Tool + 多通道**

1. 补齐 Tool：`file_read/write/move/delete`、`process_list`、`power`、`notify_send`（共 10 个）
2. 多通道接入：Telegram + 微信（飞书已在 Phase 1 跑通）
3. 跨通道记忆统一：`session.identityLinks` + `dmScope: "per-peer"`
4. 用户验证：自己用 2 周，记录哪些功能真正用到，据此调整后续优先级
5. CI/CD：GitHub Actions，push tag → 自动构建 Windows + Linux

::: tip 交付物
10 个 Tool 可用，微信/飞书/Telegram 三通道记忆互通
:::

## Phase 3：多设备 + 平台扩展（6 周）

**目标：多设备互联 + Linux 适配 + 跨设备文件传输**

1. CLI 客户端适配 Linux / NAS / 树莓派（systemd / Docker 部署）
2. 多设备注册与路由：设备列表、按名称分发命令
3. 跨设备文件传输：`file_transfer`（控制平面走 Gateway + 数据平面直连）
4. Android MCP 技术验证 ✅ 已完成（方案 B：nodejs-mobile，13/20 Tool 可用，7 个 isAndroid 守卫）
5. 远程桌面技术验证（控制/数据平面分离架构，见 [可行性分析](/feasibility)）

::: tip 交付物
多设备互联，手机（飞书）找电脑文件、电脑查服务器日志
:::

## 打包发布阶段（Phase 3 完成后）

按依赖顺序：

| 序号 | 任务 | 产出 | 状态 |
|------|------|------|------|
| ① | 截屏实测 | Android MediaProjection 弹窗 + 回图 | ⏳ 待测 |
| ② | npm gca-server 打包 | `npx gca-server start` 全局安装 | ○ |
| ③ | 一键部署脚本 | `curl \| bash` 全自动部署 | ○ |
| ④ | npm gca-client 验证 | `gca pair` → `gca start` 端到端 | ○ |
| ⑤ | .deb 打包 | `dpkg -i gca-server.deb` | ○ |

.exe 打包留到 Phase 4 Tauri 桌面端。

## Phase 4+：按实际使用反馈决定

候选方向（**不预先承诺顺序**）：

- Tauri 桌面客户端（设备仪表盘 / 远程桌面 UI）
- Android 客户端（方案 B 已验证通过，13 Tool 可用，arm64 + x86_64 双架构 APK；7 个系统级 Tool 待 Kotlin JNI 桥接补全）
- 远程桌面完整实现（MJPEG 推流 + 键鼠直通 + 剪贴板同步）
- AI 应用操控（ui_tree 优先，browser 自动化，OCR 兜底）
- 智能家居与 IoT（树莓派 GPIO / Home Assistant）
- 安全加固（E2E 加密 / RBAC / 审计）与正式发布

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OpenClaw 不可用或 API 变更 | 全部重写 | **Phase 0 先验证**；锁定版本；适配层隔离 |
| 范围蔓延 | 回到 2-3 年计划 | 每 Phase 锁定范围，Phase 1 不做清单白纸黑字 |
| 个人开发者精力有限 | 进度延迟 | 每阶段独立交付可用产品 |
| 无用户验证 | 做了没人用的功能 | Phase 2 强制自用 2 周，按反馈排 Phase 4+ |
| 外网访问不稳定 | 连接中断 | Phase 1-2 不依赖外网穿透；Tailscale 定位是辅助工具，推迟到 Phase 3+ |

## 产品化集成形态（2026-07-26 拍板，决策 12）

全部做成集成化软件，按角色分两端：

- **服务端** = OpenClaw Gateway（保留，AI 大脑/通道/模型路由）+ **GCA 控制面**（`gca-server` 单守护进程：配对中心 + 审批推送 + 设备管理 + 审计集中）
- **客户端** = `gca-client`（npm 全局包，现 poc 演进）：MCP Server + 审批引擎 + CLI
- **边界**：MCP 工具调用（Gateway→客户端）· 审批配对控制面（客户端↔gca-server）· 数据面（客户端↔客户端直连，服务端永不碰文件内容）

第一块砖：**INT-001 配对握手协议**（服务端出一次性配对码 → 客户端 `gca pair <码>` 自动交换 pairing token + 自动注册进 Gateway mcp.servers）——新设备 5 分钟上线。任务详见 `backlog.md` 模块 7（INT-001~005）与第 11 批。

## 验证方式

| 阶段 | 验证用例 |
|------|----------|
| Phase 0 | 飞书发只读命令 → 收到执行结果（EARS 14 条） |
| Phase 1 | 上方 4 条验收用例全部通过 |
| Phase 2 | 微信发消息控制设备成功；跨通道记忆生效（微信说的事飞书知道） |
| Phase 3 | 2+ 设备同时在线；NAS 文件传到电脑成功 |

---

## 附录：原 5 阶段长期愿景（已被上方修订路线取代）

::: details 点击查看原始 28 周计划（仅供参考，不再作为执行依据）
原计划在可行性分析中被判定为「个人开发者 2-3 年工作量」，已于 2026-07-23 决策收窄。

| 阶段 | 周期 | 内容 |
|------|------|------|
| Phase 1 | 4 周 | 10 个 MCP Tool + Windows 客户端 |
| Phase 2 | 6 周 | Android 客户端 + 远程控制 |
| Phase 3 | 6 周 | Tauri 桌面客户端 + AI 操控 |
| Phase 4 | 6 周 | IoT + 智能家居 |
| Phase 5 | 6 周 | 安全加固 + 发布 |

修订理由：36 Tool × 4 平台 × 远程桌面 × AI 操控的范围对个人开发者不现实。
原计划的各项内容并未删除，而是重新排布到修订路线的 Phase 2/3/4+ 中。
:::
