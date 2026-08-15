# 开发代办清单

> 按模块拆分，每个功能独立任务 · 2026-07-23 按修订路线图重排

| 指标 | 数值 |
|------|------|
| 模块 | 6 |
| 任务总数 | 56 |
| P0 | 15 |
| P1 | 20 |
| P2 | 21 |

::: tip POC 进展（Phase 0，代码已完成）
以下能力已在 `poc/` 实现并通过测试（**77/77 单元测试 + 8/8 E2E 测试全过**，2026-07-23 验证）：

- **C-001 MCP Server 框架**（Express + SSE 传输，per-connection 实例）✅
- **C-008 exec Tool 核心**：命令分类器（readonly/write/dangerous）+ 三级审批 + 执行器 ✅（审批对接聊天通道属 Phase 1）
- **P-001 Windows 平台适配**（exec 链路部分）✅
- **C-002 file_list / C-011 sysinfo** ✅（代码 + 21 个单元测试用例全绿；MVP 三 Tool 代码面齐活）

待进行：Ubuntu VM 部署 OpenClaw Gateway + 飞书 Bot 联调（见 `poc/docs/openclaw-ubuntu-setup.md`）。VM 连通性已验证（ping <网关IP> <1ms，OpenSSH 9.5 客户端在位）。
:::

::: warning 优先级说明
下方 P0/P1/P2 是**模块内原始优先级**。「建议开发顺序」已按[修订后路线图](/roadmap)重排：**Phase 1 只做 exec + file_list + sysinfo 三个 Tool**，原第 2 批的"8 个 Tool"已拆分。
:::

## 模块 1：shared — 共享类型与协议

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| S-001 | 定义 MCP Tool 类型 | ~~36 个 Tool 的 TypeScript 类型~~ **Phase 1 范围 ✅ 2026-07-24**：`src/types/tools.ts` 落地 4 个已实现工具的 wire 结果类型 + TOOL_NAMES 注册表，handler 全部编译期校验；输入类型改为 z.infer 派生（单一数据源）。36 Tool 全量目录随 Phase 2/3 按批补充（type-first） | P0 | — |
| S-002 | 定义设备配置类型 | ✅ 2026-07-24：`src/config.ts` 集中读取并校验全部环境变量（端口/设备名/日志级别/exec 限额/审批 TTL/会话 TTL），6 个文件的散读点已归并 | P0 | — |
| S-003 | 定义数据通道协议 | 屏幕推流、文件传输、键鼠事件的 WS 消息格式 | P1 | — |
| S-004 | 定义客户端状态类型 | 连接状态、Tailscale 状态、设备在线状态枚举 | P1 | — |
| S-005 | JSON Schema 生成 | 从 TypeScript 类型自动生成 JSON Schema | P2 | S-001 |

## 模块 2：client/server — MCP Server 核心

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| C-001 | MCP Server 框架 | 用 @modelcontextprotocol/sdk 搭建基础框架，SSE 传输（POC ✅ 已实现；**Streamable HTTP ✅ 2026-07-24 完成**：/mcp 端点 + 会话管理，Gateway 已切 streamable-http，/sse 保留回退） | P0 | S-001 |
| C-002 | file_list Tool | 列出目录内容，支持 glob 过滤和递归 | P0 | C-001 |
| C-003 | file_read Tool | 读取文件内容，支持行范围（✅ 2026-07-24：行范围/二进制嗅探/64MB+4000行+512KB 三重上限，8 单元测试） | P0 | C-001 |
| C-004 | file_write Tool | 写入/创建文件（✅ 2026-07-24：overwrite/append/createDirs，写操作走 confirm 确认闭环不内联执行） | P0 | C-001 |
| C-005 | file_move Tool | 移动/重命名（✅ 2026-07-24：同走 confirm 确认闭环） | P0 | C-001 |
| C-006 | file_delete Tool | 删除文件（✅ 2026-07-24：confirm 确认闭环 + 根目录护栏 + 非空目录需 recursive=true） | P1 | C-001 |
| C-007 | file_transfer Tool | 跨设备文件传输（✅ 2026-07-25：file_serve 一次性票据 + /transfer 端点 + file_fetch 直连下载，**票据 URL 即授权免二次确认**；UDP 路由选真网卡 IP；实测 Windows→VM 51 字节中文内容两端一致） | P2 | C-001, S-003 |
| C-008 | exec Tool | 执行命令并返回结果，支持超时；三级审批（POC ✅ 已实现分类/审批/执行；**审批对接聊天通道 ✅ 2026-07-24 完成**：写操作返回 confirmToken，聊天中确认后经 exec_confirm 执行，飞书实测通过） | P0 | C-001 |
| C-009 | exec_background Tool | 后台执行长时间命令，返回任务 ID（✅ 2026-07-24：任务注册表 + 输出重定向到日志文件，复用 file_read/process_list 查看，三级审批同源） | P1 | C-008 |
| C-010 | process_list Tool | 列出进程，支持 CPU/内存排序（✅ 2026-07-24：Windows PowerShell / POSIX ps 双实现，过滤器 JS 侧应用零注入面，5 单元测试） | P0 | C-001 |
| C-011 | sysinfo Tool | 返回 CPU/内存/磁盘/网络/运行时间 | P0 | C-001 |
| C-012 | power Tool | 关机/重启/休眠/WoL（✅ 2026-07-24：**OTP 验证码带外确认**（码弹本机屏幕，AI 不可见）+ abort 免确认取消 + 30s 最小延迟兜底；分类器已封死 shutdown/rundll32/Restart-Computer/systemctl poweroff 等全部绕行路径） | P1 | C-001 |
| C-013 | service Tool | 系统服务管理（✅ 2026-07-24：list 只读免审 + start/stop/restart 走 OTP；Windows PowerShell / POSIX systemctl 双实现） | P1 | C-001 |
| C-014 | notify_send Tool | 发送桌面通知（✅ 2026-07-24：msg.exe 弹窗主通道 + 服务器日志降级，兼作 OTP 带外投递通道） | P1 | C-001 |
| C-015 | Gateway 注册与自动连接 | 客户端启动时 SSE 注册到 Gateway，支持自动重连 | P0 | C-001 |
| C-016 | 独立代理支持 | SOCKS5/HTTP 代理（✅ 2026-07-24 落配置管道：config.proxy（env 派生）+ `getProxyForUrl()`（settings 优先于 env + NO_PROXY 后缀匹配）；当前架构 Gateway 拨入零外呼，管道留给 OTA/文件传输等未来外呼功能） | P1 | C-015 |
| C-017 | MCP Resources | device://list、device://{id}/status 资源暴露 | P2 | C-001 |
| C-018 | MCP Prompts | troubleshoot、optimize 预置提示词 | P2 | C-001 |

## 模块 3：client/platform — 平台适配

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| P-001 | Windows 平台适配 | 屏幕捕获、系统信息、命令执行 | P0 | C-001 |
| P-002 | Linux 平台适配 | 复用 Windows 代码，适配 Linux（✅ 2026-07-25：credential-store 增加 file-perm 降级（600 权限，~/.aws 同款）+ power-actions POSIX 分支（shutdown -h/-r +N、systemctl、shutdown -c 中止）+ 2 个测试平台化修正；**Linux 完整测试套件 171/171 与 Windows 全绿**；VM 实机起服注册 gca-vm 第二设备，systemd 常驻，双设备 agent 实测通过） | P1 | P-001 |
| P-003 | macOS 平台适配 | 复用代码，适配 macOS 特定 API | P2 | P-001 |
| P-004 | Android 平台适配 | ✅ 2026-07-26：nodejs-mobile libnode.so + JNI 桥 + esbuild bundle，APK 交付，13/20 Tool 可用，7 个 isAndroid 守卫 | P1 | P-001 |
| P-005 | CLI 平台适配 | 无 UI 版，Node.js CLI，systemd/Docker | P1 | C-001 |
| P-006 | 连接生命周期 — 通联检测 | 启动时测试 Gateway 是否可达（**streamable-http 架构下改为服务端启动自检 ✅ 2026-07-24**：/health + MCP initialize + tools/list + DELETE 全链自探，失败记 error 不致命） | P0 | C-015 |
| P-007 | 连接生命周期 — Tailscale 管理 | 按需启停 Tailscale | P1 | P-006 |
| P-008 | 连接生命周期 — 心跳保活 | 每 30s ping，连续 3 次无响应判定断开 | P0 | C-015 |
| P-009 | 连接生命周期 — 断线重连 | 指数退避重连（1s→2s→4s→...→60s） | P0 | P-008 |
| P-010 | 连接生命周期 — 退出恢复 | 退出时恢复 Tailscale 到进入前状态 | P1 | P-007 |
| P-011 | 配置管理 | 本地 JSON 配置读写、系统 keychain 凭据存储（✅ 2026-07-24：`settings-store.ts` 原子写 + `credential-store.ts` **DPAPI 零依赖凭据存储**（CurrentUser 作用域，-EncodedCommand 无注入面，密文不落明文），13 单元测试） | P1 | S-002 |

## 模块 4：client/ui — 客户端界面

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| U-001 | 设置页面 | Gateway 地址、token、代理、设备名称配置 | P0 | P-011 |
| U-002 | 连接状态指示器 | 顶部状态栏显示 Gateway/Tailscale 状态 | P1 | P-008 |
| U-003 | 设备列表页面 | 所有设备卡片（名称、在线状态、CPU/内存概览） | P1 | C-015 |
| U-004 | 设备详情页面 | 单设备完整信息 | P2 | U-003 |
| U-005 | 文件浏览器 | 远程目录树、文件列表、面包屑导航 | P1 | C-002 |
| U-006 | 文件查看器 | 文本文件查看、图片预览 | P2 | U-005 |
| U-007 | 文件上传/下载 | 拖拽上传、下载进度条 | P2 | U-005, C-007 |
| U-008 | 远程终端 | 命令输入框、输出显示、历史记录 | P1 | C-008 |
| U-009 | 远程桌面视图 | 屏幕推流显示区域 | P2 | S-003 |
| U-010 | 远程桌面输入 | 鼠标点击/移动/滚动、键盘输入转发 | P2 | U-009 |
| U-011 | 远程桌面工具栏 | 全屏、缩放、剪贴板同步、快捷键 | P2 | U-009 |
| U-012 | AI 聊天界面 | 消息列表、输入框、Markdown 渲染 | P1 | C-015 |

## 模块 5：远程控制与 AI 操控

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| R-001 | screenshot Tool | 截取屏幕，返回 base64 JPEG（✅ 2026-07-26：System.Drawing 截屏 + WinRT OCR，许可窗内免审/窗外确认；**模型实测多模态可见屏幕**） | P1 | P-001 |
| R-002 | remote_input Tool | 鼠标移动/点击/滚动/键盘输入（✅ 2026-07-26：Win32 SendInput + SendKeys / Linux xdotool，许可窗内免审/窗外确认；**实测模型在桌面打字成功**） | P1 | P-001 |
| R-003 | clipboard_sync Tool | 剪贴板读写/同步（✅ 2026-07-26：设备间自动同步 via gap-relay，Windows Clipboard API / Linux xclip+文件降级；**实测 Windows 复制→VM 收到**） | P1 | P-001 |
| R-004 | remote_stream Tool | 开始/停止屏幕推流，WS 数据端口（✅ 2026-07-26 技术选型完成：**WebSocket + JPEG 帧**，不用 WebRTC/VNC；v2 实施排期见 docs/r-004-streaming-selection.md） | P2 | R-001, S-003 |
| R-005 | ui_find Tool | 通过 Accessibility API 查找 UI 元素 | P2 | P-001 |
| R-006 | ui_act Tool | 操作 UI 元素（点击/输入/选择/读取） | P2 | R-005 |
| R-007 | browser_open Tool | 打开 URL / 操控远端浏览器 | P2 | C-001 |
| R-008 | browser_act Tool | 浏览器内操作 | P2 | R-007 |
| R-009 | ocr_screen Tool | 屏幕 OCR 文字识别 | P2 | R-001 |
| R-010 | ui_tree Tool | 本地 Accessibility API 提取结构化 UI 元素树（零 API 成本，优先于截图方案） | P2 | P-001 |

## 模块 7：产品化集成（gca-client / gca-server）

> 2026-07-26 用户拍板方向：全部做成集成化软件，按角色分服务端与客户端。
> 服务端 = OpenClaw Gateway（保留）+ GCA 控制面（打包 gca-server 单守护进程）；客户端 = gca-client（npm 全局包，现 poc 的 90%）。
> 边界：MCP 工具调用（Gateway→客户端）/ 审批配对控制面（客户端↔gca-server）/ 数据面（客户端↔客户端直连，服务端不碰数据）。

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| INT-001 | 配对握手协议 | 服务端出一次性配对码 → 客户端 `gca pair <码>` → 自动交换 pairing token + 自动注册进 Gateway mcp.servers（替代手工 setup:pairing + 手工改 openclaw.json）（✅ 2026-07-26：pair-init/pair-claim 端点 + CLI pair/pair-init 命令，实测 WKPFS8 码 claim 成功自动注册） | P0 | — |
| INT-002 | gca-client npm 打包 | 全局可安装 npm 包：bin `gca`（setup/pair/start/doctor/service）+ 依赖瘦身 + 安装文档（✅ 2026-07-26：package.json 改名 gca-client + bin 入口 + pair/pair-init 脚本） | P0 | INT-001 |
| INT-003 | gca-server 控制面 | gap-relay 升级为单守护进程：配对中心（签发配对码）+ 审批推送 + 设备清单/吊销 + 审计集中 | P1 | INT-001 |
| INT-004 | 服务端发现 | 阶段一客户端手填服务端地址；阶段二 LAN mDNS 自动发现（✅ 2026-08-12：server 发布 `_gca-server._tcp.local.` + desktop QU 单播发现 + 端口扫描回退；见 docs/api.md §mDNS） | P2 | INT-002 |
| INT-005 | 审计日志集中 | 客户端操作日志（审批/执行/传输）推送 gca-server 集中留痕（✅ 2026-08-12：agent/TS 挂钩审批·执行·拦截·免确认传输，`GCA_AUDIT_PUSH=1` 可选开关默认本地；desktop 注入 GCA_SERVER_URL） | P1 | INT-003 |

## 模块 6：OTA 更新与 CI/CD

> 策略：小更新 JS bundle OTA 静默推送，大更新重装（Android APK / Desktop 安装包）。**Phase 0/1 CLI 客户端通过 npm/gca-cli update 更新，不涉及此模块。**

| 编号 | 任务 | 说明 | 优先级 | 依赖 |
|------|------|------|--------|------|
| O-001 | CI/CD 流水线 | push tag → 自动构建 Desktop + Android + CLI | P1 | — |
| O-002 | Android JS bundle OTA | expo-updates：启动检查 + 每 24h 检查 → 静默下载 | P1 | O-001 |
| O-003 | Desktop 自动更新 | Tauri updater：检查 latest.json → 后台下载 | P1 | O-001 |
| O-004 | CLI 自动更新 | gca-cli update 命令 | P2 | O-001 |
| O-005 | OTA 发布脚本 | 一键导出 JS bundle 并上传到 Gitee | P1 | O-002 |

## 建议开发顺序（2026-07-23 按修订路线图重排）

| 批次 | 阶段 | 任务 | 产出 |
|------|------|------|------|
| **第 1 批** | Phase 0 | ~~C-001, C-008~~（POC ✅ 已完成） | MCP Server + exec 三级审批 |
| **第 2 批** | Phase 0 | Ubuntu VM 部署 OpenClaw + 飞书 Bot 联调 | POC 端到端验收（EARS 14 条） |
| **第 3 批** | Phase 1 | ~~C-002, C-011, S-001, S-002~~ ✅ **全部完成（2026-07-24）** | **MVP 3 Tool**：exec + file_list + sysinfo |
| **第 4 批** | Phase 1 | ~~SSE→Streamable HTTP 迁移 + 审批对接聊天通道 + pino 日志 + 连接生命周期~~ ✅ **全部完成（2026-07-24）**：streamable-http 架构下 C-015/P-008/P-009 由 Gateway 侧天然覆盖（按需拨入+health-monitor 300s 探测+自动回连，实测三次重启均自动恢复），服务端补 P-006 启动自检 + 空闲会话 TTL 清扫 | 连接生命周期 + 错误恢复 |
| **第 5 批** | Phase 2 | ~~C-003~C-006, C-009, C-010, C-012~C-014（共 10 Tool）+ 多通道（Telegram/微信）+ identityLinks~~ ✅ **全部完成（2026-07-24）**：9 Tool + confirm 泛化 + OTP 验证码；飞书/微信双通道；identityLinks 跨通道会话合并 | 10 Tool + 多通道记忆 |
| **第 6 批** | Phase 2 | ~~P-011, C-016~~ ✅（2026-07-24）+ 用户自用验证 2 周（进行中，靠日常使用积累反馈） | 配置管理 + 代理 + 使用反馈 |
| **第 7 批** | Phase 3 | ~~P-002, P-005 + C-007, S-003 + 多设备路由~~ ✅ **全部完成（2026-07-25）**：GAP-v2 全链路 + CLI 平台化 + Linux 适配双平台全绿 + 双设备上线 + 跨设备文件传输 | Linux/NAS 适配 + 跨设备文件传输 |
| **第 8 批** | Phase 3 | ~~P-004（方案 B nodejs-mobile）+ R-001~R-004 技术验证~~ ✅ **全部完成（2026-07-27）**：Android APK 交付（13/20 Tool，7 个 isAndroid 守卫）+ screenshot + remote_input + clipboard_sync + 推流选型 | Android MCP 验证 + 远程桌面验证 |
| **第 9 批** | Phase 4+ | U-001~U-012（Tauri 桌面端）+ R-005~R-010（AI 操控） | 桌面客户端 + AI 应用操控 |
| **第 10 批** | Phase 4+ | O-001~O-005, S-005, P-003, P-007, P-010 | CI/CD + OTA + macOS + Tailscale 管理 |
| **第 11 批** | 产品化 | ~~INT-001 配对握手协议~~ ✅ ~~→ INT-002 gca-client npm 打包~~ ✅ → INT-003 gca-server 控制面（INT-004/005 后补） | 集成化软件形态：5 分钟新设备上线 |
