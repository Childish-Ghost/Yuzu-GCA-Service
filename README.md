# GCA — Global Control Assistant

跨设备远程控制与 AI 自动化系统。一个 Gateway 管理多台设备，飞书/微信一句话指挥任意一台。

> **📖 总纲文档：[GCA-MASTER.md](GCA-MASTER.md)**（项目全貌/状态/决策/命令/文档地图——先读它）

## 架构

```
你（飞书/微信）
   ↕
OpenClaw Gateway（AI 大脑：模型 + 通道 + 会话）
   ├── gca-server（控制面：注册/审批/推送/审计/设备代理，VM 18790）
   ├── Rust 重构（Cargo workspace，主推）
   │   ├── agent/      设备端（零依赖 std TCP）
   │   │   ├── gca-agent   AI 通道 MCP server（20 工具 + 审批，3001）
   │   │   └── gca-term    人终端（ConPTY + SSE 流式，免审批，3011）
   │   └── desktop-rs/ 控制端（egui GUI：登录/嗅探/设备/远程终端/托盘）
   ├── client/      旧 Node MCP Server 客户端（已弃用，Android 已原生化）
   ├── (desktop/ 已归档 → archive/desktop-tauri/)
   └── android/     Android APK（Rust agent，JNI 直启 libgca_agent.so）
```

## 项目结构

```
gca/
├── agent/      Rust 设备端（agent 20 工具 + term 真终端，零依赖 std + serde_json）
├── desktop-rs/ Rust 控制端（egui：登录嗅探/本机模式/设备详情/远程终端/托盘/自启）
├── server/     gca-server 控制面（注册/审批/推送/审计/设备 MCP+终端代理/控制面板 UI）
├── client/     Node MCP Server 客户端（Android 在用）
├── (desktop/ 已归档 → archive/desktop-tauri/)
├── android/    Android APK（Rust agent，JNI 直启）
├── docs/       文档（project-status.md 为跨会话恢复锚点）
└── scripts/     运维/部署脚本（restart-gca-services / tobii-aby-test / deploy-gca-server）
```

## 构建与测试（Rust workspace）

```bash
cargo build --release --workspace
# 产物：target/release/gca-agent.exe + gca-term.exe + gca-desktop-rs.exe

cargo test --workspace
# agent/desktop 单测（以 GCA-MASTER「49 测试全绿」为当前真值；
# term_flow/term_full_flow 需本机 3011 gca-term 运行）
```

- **agent**：环境变量配置（`GCA_AGENT_PORT`/`GCA_MCP_TOKEN`/`GCA_DEVICE_NAME`/`GCA_MACHINE_ID`；term 独立 `GCA_TERM_TOKEN`/`GCA_TERM_PORT`(3011)/`GCA_TERM_IDLE_MS`(300000)）
- **真终端（C-1）**：ConPTY（默认系统 conhost 主机；`GCA_CONPTY_SIDELOAD=1` 切 sideload OpenConsole）+ SSE 流式 + vte 解析 + 自写网格渲染
- **desktop-rs**：登录后自动带起本机 agent/term（localmcp）；「⚡ 本机模式」直连 127.0.0.1:3001；Rust 原生 Win32 托盘；托盘退出 = 全套退出（agent/term 跟随）；IP 心跳（5 分钟，DHCP 变动自动更新设备 URL）
- 防火墙：杀软可能自动给 gca-agent.exe 加阻止规则 → 跑 `desktop-rs/fix-firewall.cmd`（需管理员）

## 快速开始

### 服务端（VM）

```bash
cd server
npm install && npm run build

# 配置 token（首次）
GCA_SERVER_TOKEN=$(openssl rand -hex 32) node dist/cli.js setup

# 启动（systemd）
systemctl --user enable --now gca-server
```

### 控制端（Windows 10+ 桌面）

```bash
cargo build --release -p gca-desktop-rs
# 运行 target/release/gca-desktop-rs.exe
# 或跑根目录 scripts/restart-gca-services.cmd（自动退出旧进程 → 构建 → 重启）
```

首次启动输入服务器地址 + 密钥登录（登录页可「🔍 嗅探局域网服务器」自动发现）。设备未注册时自动提示注册。远程终端：设备列表 → 详情 → 🖥 远程终端（cmd/PowerShell 切换、目录树）。

### 被控设备（Windows）

装 desktop-rs 并登录一次（localmcp 自动拉起 agent/term + 注册），或手动运行 gca-agent/gca-term（需 GCA_MCP_TOKEN/GCA_TERM_TOKEN 配置）。

## 审批流程

所有高危操作统一走 gca-server ops 审批：

```
设备发起操作（注册/关机/重启/服务管理）
  → gca-server 生成 6 位确认码 → 推送飞书+微信
  → 用户回复确认码 → AI 调 confirm
  → gca-server 审批 → 设备执行
```

## 设备唯一标识

- 每台设备有稳定 machineId（SMBIOS UUID）
- 注册匹配用 machineId，不依赖设备名
- IP 变动由 desktop 心跳（/heartbeat）自动更新设备 URL

## 文档

- [项目状态（跨会话恢复，先读这个）](docs/project-status.md)
- [接口文档（UI/终端交接）](docs/api.md)
- [设备唯一标识方案](docs/device-identity.md)
- [架构设计](docs/architecture.md)
- [系统流程](docs/flow.md)
- [审批协议](docs/gap-v2.md)
- [开发代办清单](docs/backlog.md)
- [进度仪表盘](docs/progress-dashboard.html)
