# GCA 总纲（Master）· 2026-08-11

> **本文件是唯一入口**——项目是什么、当前状态、关键决策、常用命令、待办、文档地图，全部在这里。
> 细文档见 [文档地图](#七文档地图)（按需翻阅，不必全读）。
> 压缩上下文/新会话：读本文件即可恢复全貌；需要细节再进对应细文档。

---

## 一、项目是什么

**GCA（Global Control Assistant）**——跨设备远程控制与 AI 自动化系统。
飞书/微信一句话指挥任意一台设备：AI 通道（MCP）+ 人终端（真终端）+ 控制面（注册/审批/审计）。

```
你（飞书/微信）
   ↕
OpenClaw Gateway（AI 大脑，VM <网关IP>）
   ├── gca-server   控制面（18790）：注册/审批/推送/审计/设备代理/控制面板 UI
   ├── gca-agent    设备端 AI 通道（3001）：MCP server，20 工具 + 审批
   ├── gca-term     设备端人终端（3011）：ConPTY 真终端 + SSE 流式，免审批
   ├── gca-desktop-rs  控制端（egui）：登录/设备/远程终端/托盘/心跳
   ├── Android APK（Rust agent，20 工具，JNI 直启 libgca_agent.so）
   └── archive/        旧代码归档（poc / Tauri desktop / docs 历史 / TestServer）
```

- **语言/技术**：Rust（agent + desktop-rs，Cargo workspace，零依赖 std TCP）+ Node（gca-server）
- **Windows 部署**：desktop-rs 控制端 + agent/term 被控端（三组件互相独立，任意组合）
- **数据面**：跨设备文件传输走一次性票据（`/transfer/{token}`）

## 二、当前状态（2026-08-11）

| 组件 | 状态 |
|------|------|
| gca-agent（20 工具 + 审批 + consent） | ✅ 本机运行（3001） |
| gca-term（ConPTY 真终端 + SSE） | ✅ 本机运行（3011）——**显示/输入/弹窗问题已全部修复** |
| gca-server（注册/审批/代理/控制面板） | ✅ VM 部署（18790）——含 /heartbeat 与 SSE query 修复 |
| gca-desktop-rs（登录/设备/终端/托盘/心跳） | ✅ 本机运行 |
| 在线设备 | gca-win11（Windows）+ gca-2312CRAD3C（Android） |
| 测试 | `cargo test --workspace` 56 项全绿（原 49 + D4 确认协议等 7）；client 7 + server 16（mdns 畸形包/SSRF 矩阵）；1 项实网测试 @ignore |
| 版本 | 组件版本：desktop-rs 0.4.0 · agent+term 0.2.0 · server 0.4.0（双版本模型见 docs/versioning.md） |
| 发布 | **B0.5.0 测试版已发布**（2026-08-15，B 通道，原 v0.5.0 正式版已降级为 beta）：Android 原生化 + 审批三通道 + 组件选择安装程序 + 双轮审查全量修复——`gca-setup-win-B0.5.0.exe` + `gca-agent-android-B0.3.0.apk` + `gca-server-0.5.0.zip` + `gca-server-linux-B0.5.0.deb`；gitea + GitHub 双地址均已发布（GitHub 公开镜像 github.com/Childish-Ghost/Yuzu-GCA-Service，脱敏单根，发布红线见 docs/review-baseline.md）；组件 0.5.0/0.3.0/0.5.0/0.3.0（beta.1/2/3 历史见 versioning.md） |
| 事件驱动 | **阶段一 + 阶段二完成**（2026-08-12）：server 集中探测 + /events SSE + desktop 订阅四态 + 面板订阅（设备状态列/○● 指示/在线计数）全部落地（44 测试全绿 + VM 已部署实测）；Android 子项随原生化完成（P3 心跳/审计接入，四态经 server 集中探测覆盖）——docs/event-driven-plan.md |
| 审批三通道 | **2026-08-14 完成**：① Android App 审批卡片流（SSE `/ops/events` 下发 + 弹窗指纹 + 上滑切换/左滑同意/右滑拒绝 + singleTop 去重）；② 飞书交互卡片（授权框 + 按钮回调经 OpenClaw gca-approval 扩展 → `/ops/card-action` + 原地回写）；③ 按 id 审批端点（`/ops/:id/approve\|reject`）+ 列表（`/ops?status=pending`）+ dashboard 面板审批；微信审批通道移除（会话保留）；真实设备注册审批端到端实测 |
| P2 待办池 | **INT-004 mDNS + INT-005 审计集中 完成**（2026-08-12）：审计推送（`GCA_AUDIT_PUSH=1` 默认本地，四类事件挂钩）端到端实测（agent → server /audit 落地）；mDNS（server 发布 + desktop QU 发现）跨机实测（本机 → VM <网关IP> 应答）——决策 12/13，待用户重启桌面端生效 |

## 三、关键决策（勿回退）

1. **设备 MCP 代理**：desktop 不直连设备（配对 token 只在网关侧）→ gca-server `POST /device/:name/mcp` 转发；终端同理 `/device/:name/term/*`（端口 +10 约定）
2. **本机模式直连**：server_url=127.0.0.1:3001 时详情/终端走 `{url}/mcp` 直连
3. **真终端（C-1）**：ConPTY + SSE 流式 + vte 解析 + 自写网格渲染；**默认系统 conhost 主机**（`GCA_CONPTY_SIDELOAD=1` 切 sideload OpenConsole——sideload 曾导致 PSReadLine 行号偏移，勿恢复默认）
4. **会话尺寸"创建即正确"**：SSE 连接 query 带 `?cols=X&rows=Y`（shell 在正确网格下启动）；切 shell 沿用 LAST_SIZE——避免行号偏移
5. **输入串行化 + seq**：同一时刻至多一个输入 POST 在途，失败精确回填重试（防丢字符/重复）
6. **agent 零依赖**：HTTP 手写（std::net）、JSON 用 serde_json、审批分类器手写正则
7. **exec 输出编码**：cmd /C + `chcp 65001>nul &&` 前缀强制 UTF-8
8. **托盘退出 = 全套退出**：desktop 退出时一并结束 agent/term（无 UI 残留进程）
9. **IP 心跳**：desktop 登录即上报 + 每 5 分钟 `/heartbeat`（DHCP 变动自动更新设备 URL）
10. **脚本编码**：`scripts/restart-gca-services.cmd` 等必须 **GBK + CRLF**（UTF-8/LF 双击会被 cmd 吞换行闪退）
11. **双版本模型（2026-08-12）**：组件版本（源码真值，各自独立演进，agent 没改永远 0.1.0）+ 产品发布号（发版协调快照，只进 tag/Release/多组件包名，不进 manifest）；产物命名 `<包名>-<平台>-<V/B/D>X.Y.Z.<格式>`；B 通道 tag `BX.Y.Z`（多轮迭代 `BX.Y.Z-beta.N`）；手动编号，不搞 CI——规范见 docs/versioning.md
12. **审计集中开关（2026-08-12，INT-005）**：`GCA_AUDIT_PUSH=1` 才推送（默认本地留痕）；推送目标 `GCA_SERVER_URL/audit`（desktop 登录后注入 agent/term 环境）；agent/TS 挂钩审批（approval_granted）/免审执行（exec）/拦截（exec_blocked）/免确认传输（file_fetch）四类
13. **mDNS 发现（2026-08-12，INT-004）**：server 发布 `_gca-server._tcp.local.`（224.0.0.251:5353，TTL 120s，每 60s 重发）；客户端 PTR 查询带 **QU 位**（单播应答，临时端口可收）；desktop 逐本机 IP 钉接口发查询（Windows 默认组播出口可能落虚拟网卡——实测 172.29 WSL 网卡不出物理网），无应答回退全网段端口扫描（scan.rs 保留）

## 四、最近修复史（2026-08-09~11 完整链，细节见 project-status.md 踩坑史）

| 问题 | 根因 | 修复 |
|------|------|------|
| 编译错误 | 未提交代码 borrow-after-move | 修复 + 输入重试串行化/seq |
| 0xc0000142 弹窗 | 机器级注入干扰（Tobii 崩溃循环为嫌疑，未证实） | SetErrorMode 抑制 + 死会话自动重生 |
| 终端显示错位（提示符消失/输入缩进/倒数第二行/字符错乱） | **① TermScreen 未实现 \x1b7/\x1b8（DECSC/DECRC）** ② sideload 主机 PSReadLine 行号偏移 ③ 渲染跳过中间空白行 ④ CPR 双应答 ⑤ resize 时序 | 全部修复：DECSC/DECRC 实现 + 默认 conhost 主机 + 中间空行占位 + 删 desktop CPR 应答 + SSE 带尺寸/LAST_SIZE |
| "连接中"卡死 | gca-server 代理 URL.pathname 把 `?` 转义成 %3F → 上游 404 | 拆 query 设 u.search（已部署 VM） |
| DHCP IP 变动离线 | agent 不主动上报 IP（gca-server 有 /heartbeat 但无人调用） | desktop 心跳（登录 + 每 5 分钟） |
| 离线探测卡 8s | 共享 client connect_timeout 8s | 降到 2s，probe 3s |
| uptime 跳跃/不跳 | egui 空闲不重绘 → 定时刷新不触发 | 登录后 1s repaint + 本地每秒跳动（uptime_base+probed_at） |
| 脚本双击闪退 | UTF-8/LF 被 cmd 按 GBK 解析吞换行 | 转 GBK+CRLF |

**验证工具**：`desktop-rs/tests/render_check.rs`（真实终端字节 → TermScreen 渲染对比，RENDER_BYTES 环境变量指定字节文件）；3012 隔离实例（GCA_TERM_PORT=3012 起 gca-term + curl SSE 带尺寸对比）。

## 四b. 全项目代码审查修复（2026-08-11，三模块并行审查）

| 模块 | 修复 |
|------|------|
| server | **JSON.parse 崩溃 DoS**（readJson 统一 try/catch——畸形 body 不再打死进程）· **SSE 代理断开崩溃+泄漏**（res.on('error')+abort+reader.cancel）· **面板 XSS**（esc/escJs 转义设备名/审计/剪贴板）· **MCP body 无上限**（1MB 截断）· **ops 表无限增长**（sweep 真正删除终态）· **reurl SSRF**（http/https 白名单+拒绝回环私网）· decodeURIComponent 崩溃（safeDecode）· fetch 超时（普通请求 30s）· **面板 escJs 语法损坏**（`\/` 转义被模板字符串折叠 → 内联脚本整体不解析，登录/撤销全死；2026-08-12 修复：双重转义，`node --check` 校验） |
| agent | **file_read slice panic**（start/end 钳制）· **curl/wget 审批绕过**（移出只读白名单 + -o/-O 检测）· **票据 URL 免确认写盘**（host 校验本机）· **Slowloris**（读超时 30s）· **exec.rs 死代码删除**（run_user/session_* 300 行，SESSIONS 300s 持锁隐患）· **service 注入**（env 传参）· **SendKeys 特殊字符**（转义）· **stdout 无上限**（1MB 截断） |
| desktop-rs | **scroll_up 光标 off-by-one**（滚动丢行——删一行）· **term_sse 数据分支缺 gen 过滤**（旧连接污染新会话）· **键盘无焦点门控**（点完按钮打字误发远程 shell——term_focused） |

**未修（记录在案）**：确认码带内返回（M6 设计问题）、开放模式无 token（M11 设计开关）、scrollback 不渲染（功能缺口）、256 色映射/反色渲染（显示增强）、uptime 详情页不跳（一致性问题）。（M7 openclaw.json 读改写竞态已于 2026-08-15 修复——withConfigLock 串行化，见 docs/review-baseline.md §七）

## 五、环境速查

- **VM**：`ssh <SSH用户名>@<网关IP>`（免密）；gca-server 重启 `systemctl --user restart gca-server`；server token 在 `~/<服务端token路径>`；openclaw.json 在 `~/.openclaw/openclaw.json`
- **本机**：gca-win11 = <本机IP>（DHCP，可能变动）；agent 3001 / term 3011
- **Android**：adb `<ADB序列号>`（<Android设备IP>）；原生化后打包 = `android/build-rust-native.cmd`（Rust .so）→ `gradlew assembleDebug`（nodejs-mobile/esbuild 链已随 P1 移除）
- **日志**：`%APPDATA%\GCA Desktop\logs\`（desktop.log / gca-term.log / gca-poc.log / term-audit.log）
- **桌面端凭据**：`%APPDATA%\GCA Desktop\config.json`
- **测试端口**：3001 被占时 `GCA_AGENT_PORT=3002`；term 测试 `GCA_TERM_PORT=3012`

## 六、常用命令与运维

```bash
# 构建 + 测试（workspace）
cargo build --release --workspace
cargo test --workspace

# 重启全套（退出 → 构建 → 启动）——日常升级用
# 双击 scripts/restart-gca-services.cmd（GBK 编码，勿改）

# 部署 gca-server（本地构建后推送 VM）
cd server && npm run build
scp -r dist/* <SSH用户名>@<网关IP>:~/gca-server/
ssh <SSH用户名>@<网关IP> "systemctl --user restart gca-server"

# 验证部署（期望 active + {"ok":true,...}）
ssh <SSH用户名>@<网关IP> "systemctl --user is-active gca-server"
curl http://<网关IP>:18790/health

# 注：scp 的 dist/* 通配是 bash 写法（Git Bash/WSL 可用）；纯 PowerShell 用：
#   Get-ChildItem dist | ForEach-Object { scp -r $_.FullName <SSH用户名>@<网关IP>:~/gca-server/ }

# GitHub 推送（github.com 直连不稳时走本地代理）：
#   git -c http.proxy=http://127.0.0.1:10808 push -f github <root>:main

# 防火墙（杀软自动加阻止规则时）
# 双击 desktop-rs/fix-firewall.cmd（需管理员）

# Tobii A/B 实验（判定 0xc0000142 弹窗根因，可选）
# scripts/tobii-aby-test.cmd off / on（需管理员）
```

## 七、文档地图

| 文档 | 职责 | 何时读 |
|------|------|--------|
| **本文件（GCA-MASTER.md）** | 总纲：全貌/状态/决策/命令/地图 | **先读这个** |
| docs/project-status.md | 跨会话恢复锚点 + 踩坑史（完整根因链） | 压缩上下文后、排查历史问题 |
| HANDOVER.md | 交接文档（旧，被本文件取代，保留历史） | 历史交接 |
| docs/api.md | 全部接口（gca-server REST / agent MCP 工具 / term 端点） | 对接/开发接口时 |
| **docs/review-report-2026-08-12.md** | **全代码进程审查报告**（四维：安全/冲突/关联/功能符合度；44 项修复 + S1 token 隔离设计 + 迁移说明） | 改动鉴权/token 时先读 |
| **docs/review-baseline.md** | **审查会话规范（安全 + 软件审查基线）**（双仓库发布红线 + 已知泄露清单 + 软件审查四维 + 密钥扫描模式 + 必跑清单） | **审查会话 / 新会话审查前先读** |
| docs/architecture.md | 架构规范（组件/端口/命名/扩展指南） | 加组件/端点时 |
| docs/progress-dashboard.html | 可视化进度仪表盘 | 概览进度 |
| README.md | 项目简介 + 快速开始（指向本文件） | 新人入口 |
| docs/session-recovery.md | **跨会话进度恢复指南**（唤醒后识别进度——先读这个流程） | **新会话第一件事** |
| docs/win7-plan.md | Win7 适配计划（约束/可行性矩阵/实施路径 A-C） | Win7 相关工作 |
| docs/versioning.md | 版本号规范（双版本模型/产物命名/通道/bump 规则/发版流程） | 发版/产物命名时 |
| docs/device-identity.md / flow.md / gap-v2.md / backlog.md | 设计文档 | 对应专题 |
| archive/docs-history/（feasibility / optimization / pm-review / roadmap 等） | 历史设计评审（2026-08-11 归档） | 历史参考 |

## 八、待办

| 优先级 | 任务 | 说明 |
|--------|------|------|
| **P1 主线 ✅ 完成** | ~~Android 原生化~~（docs/android-native-plan.md） | **P0-P4 全部完成**（2026-08-13，一天）：Rust agent JNI 直启（20 工具）、nodejs-mobile 退出（164MB→5.6MB）、S1 设备 token/心跳/审计端到端、高低版本分支、BOOT FGS 修复；**B0.4.0-beta.2 已发布**（gca-agent-android-B0.2.0.apk）；三环境验证（API 36/24/真机） |
| P2 待办池 | ~~原生化遗留~~ | ✅ **2026-08-14 清空**：key_type（A11y SET_TEXT 注入）、keystore 密码正式化（GCA_KEYSTORE_PASS 环境变量）已完成；MIUI 白名单引导（MainActivity 提示 + 用户设置） |
| P2 待办池 | **手机 = Windows 认证器（USB/IP FIDO2）** | 2026-08-14 排期：Virtual FIDO（USB/IP 虚拟 FIDO2 设备）+ soft-fido2（CTAP2 核心）可行性 PoC——Windows 弹窗识别虚拟安全密钥 → 手机 App 桥接（指纹签名，私钥在手机 Keystore）；**免蓝牙**（USB/IP 走网络）；先 PoC 验证 Windows 侧挂载路径再排期 |
| P3 | Tobii A/B 实验 | scripts/tobii-aby-test.cmd（可选，不影响使用） |
| 适配计划（后置） | Win7 适配 | docs/win7-plan.md——路径 A 浏览器终端（面板加终端页）；被控端受 ConPTY 硬墙限制 |

## 九、常见问题（FAQ）

- **终端输入回显错位/提示符消失** → 已修复（DECSC/DECRC + conhost 主机）——若复发先跑 `tests/render_check.rs` 验证
- **设备离线但本机 agent 正常** → ① IP 变动（等 5 分钟心跳自动更新，或手动调 /heartbeat）② 防火墙阻止规则（跑 fix-firewall.cmd）
- **Application Error 弹窗（0xc0000142）** → 已抑制+自愈；Tobii 是嫌疑（A/B 实验可选）
- **「连接中」卡死** → gca-server 代理 query 问题已修（部署后重连自动恢复）
- **脚本双击闪退** → 编码必须 GBK+CRLF（勿用 UTF-8 编辑保存）
- **uptime 不跳动** → 已修复（本地跳动）；agent 重启会归零（正常）
