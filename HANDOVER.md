# GCA 项目交接文档（HANDOVER）

> 生成时间：2026-07-23 22:37 · 交接原因：换平台继续开发
> 更新：2026-08-01 · **项目重构完成**：拆分为 client/server/desktop 三模块，旧代码归档到 archive/，版本 B0.2.0
> 更新：2026-08-05 · **Rust 重构**：agent/（设备端，20 工具）+ desktop-rs/（egui 桌面端）加入 Cargo workspace；跨会话先读 docs/project-status.md
> 更新：2026-08-10 · **真终端稳定性收官**：输入串行化/SSE 退避/渲染错位/尺寸错位/gca-server 代理 query 五链路修复（详见 project-status.md 踩坑史 0a）；LAST_SIZE 待重启验证
> **2026-08-11 起总纲见 [GCA-MASTER.md](GCA-MASTER.md)**（本文件保留为历史交接）

## 1. 项目是什么

**Global Control Assistant (GCA)** — 跨设备远程控制与 AI 自动化系统。
架构：OpenClaw Gateway（MCP Host，AI 大脑，跑在 Ubuntu VM <网关IP>）+ 每台被控设备装自建客户端（MCP Server）。

## 2. 当前架构（2026-08-05）

```
你（飞书/微信）
   ↕
OpenClaw Gateway（VM <网关IP>:18789，AI 大脑）
   ├── server/       gca-server 控制面（VM:18790）——注册/审批/推送/审计/设备管理
   ├── Cargo workspace（Rust，主推）
   │   ├── agent/       设备端 MCP server（零依赖 std TCP）——20 工具，Windows 已启用
   │   └── desktop-rs/  egui 桌面端——登录页嗅探/本机模式/设备详情/远程终端/托盘
   ├── client/       Node MCP Server 客户端——Windows 已被 agent-rs 替代，Android 仍用
   ├── desktop/      Tauri 桌面端（旧，保留）
   └── android/      Android APK（Rust agent 20 工具，JNI 直启，原生化 P1 完成）
```

- 设备 MCP 走 gca-server 代理：`POST /device/:name/mcp`（配对 token 只在网关侧）
- 本机模式：desktop-rs 直连 127.0.0.1:3001（agent），不走服务器
- agent 工具：exec/sysinfo/confirm/process_list/file×6/power/service/exec_background/
  screenshot/remote_input/clipboard_sync/notify_send/screen_consent/input_consent/
  file_serve/file_fetch（跨设备文件传输走一次性票据 `/transfer/{token}`）

## 3. 当前状态快照（2026-08-11）

| 项 | 状态 |
|----|------|
| 在线设备 | gca-win11（Windows，agent-rs + term）+ gca-2312CRAD3C（Android，node） |
| agent 工具 | 22 个（20 对齐 node + 审批/term 相关，2026-08-05 补齐） |
| 真终端 | ConPTY + SSE 流式 + vte 解析（默认系统 conhost 主机；GCA_CONPTY_SIDELOAD=1 切 sideload）——显示错位/缩进/弹窗问题已全部修复（详见 project-status.md 踩坑史 0a） |
| 服务端 | gca-server 18790（/register /ops/* /devices/* /pair/* /push /audit /heartbeat + 设备 MCP/终端代理 + 控制面板 UI） |
| 桌面端 | desktop-rs（egui：登录嗅探/本机模式/设备详情/远程终端/托盘/自启/IP 心跳）——旧 Tauri 已归档 |
| 设备标识 | machineId（SMBIOS UUID）；IP 变动由 desktop 心跳（/heartbeat）自动更新 |
| 审批体系 | 统一 gca-server ops：6 位确认码 → 飞书/微信推送 → 用户回复 → confirm → 审批 → 执行 |
| 单测 | `cargo test --workspace` 31 项 + 2 终端流集成全绿 |
| 版本 | Cargo workspace（desktop-rs 0.3.0 + gca-agent 0.1.0） |

## 4. 目录结构

```
gca/
├── Cargo.toml   Cargo workspace（members: desktop-rs, agent）
├── agent/       Rust 设备端（gca-agent.exe + gca-term.exe；cargo build --release --workspace）
├── desktop-rs/  Rust egui 桌面端（gca-desktop-rs.exe；fix-firewall.cmd/自启脚本）
├── client/      Node MCP Server 客户端（Android 用；cd client && npm run build）
├── server/      gca-server 控制面（cd server && npm run build）
├── (desktop/ 已归档 → archive/desktop-tauri/)
├── android/     Android APK（build-rust-native.cmd + gradlew，nodejs-mobile 已随 P1 移除）
├── docs/       文档（project-status.md 为跨会话恢复锚点）
├── scripts/restart-gca-services.cmd  重启三件套（退出→构建→启动，GBK 编码勿改）
├── scripts/tobii-aby-test.cmd        Tobii A/B 实验（可选）
└── archive/     旧代码归档（poc/gca-server/dist/src-tauri/TestServer/测试残留）
```

## 5. 审批流程（统一走 gca-server）

```
设备发起操作（注册/关机/重启/服务管理）
  → 调 gca-server（/register 或 /ops/request）
  → 生成 6 位确认码 → 推送飞书+微信
  → 用户回复确认码 → AI 调 confirm(码)
  → confirm Path 3: gca-server /ops/approve
  → device_registration → gca-server 写 openclaw.json
  → power_* → 客户端本地执行 executePowerAction
  → service_* → 客户端本地执行 executeServiceAction
```

## 6. 测试

| 套件 | 命令 | 状态 |
|------|------|------|
| 单元测试 | `cd client && npm test` | 185 全绿（重构前——历史数字） |
| E2E 测试 | `cd client && npm run test:e2e` | 19 全绿（重构前——历史数字） |
| 服务端 API | curl 各端点 | 18/18 通过（2026-07-31） |
| 当前真值 | `cargo test` + server/client 单测 | **49 全绿（GCA-MASTER 为准，2026-08-12 审查后新增 mdns 畸形包/classifier/pending 用例）** |

## 7. 部署

- **gca-server**：VM systemd（`~/gca-server/`，端口 18790，token 在 `~/<服务端token路径>`）
- **客户端**：各设备运行 `client/dist/index.js`（或 Desktop 内嵌 bundle 自动启动）
- **Desktop（已归档）**：archive/desktop-tauri/（NSIS 打包历史）

## 8. 待办

| 优先级 | 任务 |
|--------|------|
| P0 | ~~部署验证~~ ✅（desktop-rs + agent-rs 全链路已验，见 docs/project-status.md） |
| P0 | ~~agent-rs 补全 20 工具~~ ✅（2026-08-05） |
| P0 | ~~托盘 + 开机自启~~ ✅（2026-08-05，可视验证待用户） |
| P0 | **LAST_SIZE 重启验证**（2026-08-10 已改代码：切 shell 沿用最近尺寸——跑 scripts/restart-gca-services.cmd 生效后验证终端显示） |
| P1 | Android 原生化（Rust NDK + JNI）——**P0+P1 完成（2026-08-13）**：JNI 直启 agent，nodejs-mobile 退出；P2 工具适配进行中 |
| P1 | Android 端新工具（截图/键鼠等需 Kotlin 桥接） |
| P2 | INT-004 mDNS 服务发现 |
| P2 | INT-005 审计日志集中 |
| P3 | Tobii A/B 实验（scripts/tobii-aby-test.cmd off/on——判定 0xc0000142 弹窗根因，可选） |

使用方式：把本文件整份发给新 AI/新平台，说一句"按 HANDOVER 继续"即可
