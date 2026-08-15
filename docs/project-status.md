# GCA-Service 项目状态（2026-08-12 · B0.3.0 发布 + 事件驱动阶段一完成）

> 用途：跨会话上下文恢复文档。压缩上下文后先读本文件 + GCA-MASTER.md（唯一入口）。
> 接口文档：docs/api.md（含 /events SSE）
> ⚠️ 虚拟机部署时**不要碰 TestServer 目录**（archive/ 下的测试残留，忽略）
> **当前主线**：事件驱动设备状态（docs/event-driven-plan.md）——**阶段一完成**：server 集中探测 + /events SSE + desktop 订阅 + 四态显示（44 测试全绿，VM 已部署实测，断线回退/重连实机验证通过）；阶段二（Android/面板接入）待办。
> **2026-08-12 里程碑**：B0.3.0 发布（NSIS 安装程序 + 服务端包 + gitea Release）；事件驱动阶段一完成；exec.rs 死代码清理（-270 行，0 警告）。

## 1. 架构现状（Rust workspace 化）

```
D:\Yuzu-GCA-Service\
├── Cargo.toml          # Cargo workspace（members: desktop-rs, agent）
├── desktop-rs/         # 桌面控制端（Rust/egui GUI）——已可用，用户日常使用
│   ├── src/app.rs      # 主界面：登录页/设备/详情/终端/日志 + 本机模式 + 嗅探
│   ├── src/scan.rs     # 局域网嗅探（多网卡枚举 + 并行端口探测 + /health 验证）
│   ├── src/localmcp.rs # 登录后拉起本机 agent（优先 gca-agent.exe，回退 node bundle）
│   ├── src/devdetail.rs# 设备详情 + 远程终端（经 gca-server 代理或本机直连）
│   └── fix-firewall.cmd# 删除杀软自动加的 gca-agent 阻止规则（双击自提升 UAC）
├── agent/              # 设备端 agent（Rust，零依赖 std TCP MCP server）——本机已启用
│   └── src/tools/      # 20 工具（与 node 版对齐）：sysinfo/exec/confirm/process_list/
│                       #   file_*/power/service/exec_background + screenshot/remote_input/
│                       #   clipboard_sync/notify_send/screen_consent/input_consent/
│                       #   file_serve/file_fetch（模块：ps.rs 超时杀树助手、
│                       #   consent.rs 同意窗口、tickets.rs 传输票据、http.rs GET 客户端）
├── server/             # gca-server 控制面（VM <网关IP>:18790，systemd --user，已部署）
│   └── src/gca-server.ts # 含设备 MCP 代理端点 POST /device/:name/mcp
├── client/             # 设备端旧 Node 实现（Android 仍在用；Windows 已被 agent-rs 替代）
├── desktop/            # Tauri 版桌面端（旧，保留）
└── android/            # Android APK（Rust agent 原生化 P0+P1 完成——JNI 直启 libgca_agent.so，nodejs-mobile/esbuild 链已移除）
```

- **构建**：仓库根 `cargo build --release --workspace` → `target/release/gca-desktop-rs.exe` + `gca-agent.exe`
- **本机 = 被控设备 gca-win11（<本机IP>）**，VM gca-server（<网关IP>）持有设备配对 token（openclaw.json）

## 2. 已验收功能（本会话）

- [x] **desktop-rs 本机模式**：登录页「⚡ 本机模式」不连 gca-server，直连 127.0.0.1:3001（顶栏黄色标识、隐藏 AI 聊天/设备管理、详情终端直连 /mcp 不走代理）
- [x] **登录页嗅探**：扫全部网卡网段 18790 端口 → /health 验证 → 点选填地址（gca-server 的 /health 返回 `{ok:true}` 而非 `{status:"ok"}`——判定两字段都认）
- [x] **agent-rs 20 工具**（2026-08-05 补齐 8 个：screenshot/remote_input/clipboard_sync/notify_send/screen_consent/input_consent/file_serve/file_fetch——全链路验证：consent 授予→截图双 content 块、剪贴板中文往返、票据 serve→下载→单次 404、fetch 票据免确认/外部 URL 需确认、notify msg.exe 通道、无 token 401）
- [x] **localmcp 优先拉起 gca-agent.exe**（release→debug→node bundle 回退链）
- [x] **Windows agent 已替代 node client 运行在 3001**（VM 联调通过）
- [x] Android 端：SDK 1.30 crypto 兼容（esbuild banner 注入 shim）+ exec 默认 cwd=/sdcard（已打包部署 APK，adb 设备 <ADB序列号>=<Android设备IP>）
- [x] 详情页改独立页面（信息页/终端页互切）、终端工作目录框（exec 无状态 cd 不生效）
- [x] 中文字体（simhei.ttf 优先——ab_glyph 不支持 ttc）、uptime 浮点解析、camelCase 字段（hasAuth/machineId rename）
- [x] 界面汉化完成

## 3. 关键架构决策（勿改）

- **设备 MCP 代理**：Desktop 不直连设备（配对 token 只在网关侧）→ gca-server `POST /device/:name/mcp` 转发（openclaw.json 的 headers.Authorization）
- **本机模式直连**：server_url=127.0.0.1:3001 时详情/终端走 `{url}/mcp` 直连（devdetail.rs 的 direct 标志）
- **agent 零依赖**：HTTP 手写（std::net）、JSON 用 serde_json、审批分类器手写正则近似
- **exec 输出编码**：cmd /C + `chcp 65001>nul &&` 前缀强制 UTF-8
- **防火墙**：gca-agent.exe 被杀软自动加「阻止」入站规则（曾导致 VM 连不上），fix-firewall.cmd 删除；Windows 对 detached 无 UI 进程不弹申请窗，需规则处理
- **esbuild bundle Android**：必须带 `--banner:js` crypto shim（MCP SDK 1.30 webStandard 用全局 crypto.randomUUID，nodejs-mobile 无）
- **Rust agent 响应为紧凑 JSON**（grep 调试用 `"key":"val"` 无空格模式）

## 4. 待办

1. ~~agent-rs 补全工具~~ ✅（20 工具已对齐 node，2026-08-05）
2. **Android 原生化**：Rust NDK + JNI 桥接——**P0+P1 完成（2026-08-13，docs/android-native-plan.md）**；P2 工具适配进行中
3. ~~托盘 + 开机自启~~ ✅（2026-08-05 终版：Rust 原生 Win32 托盘，见下）
4. ~~Android 终端已修~~ ✅（cwd=/sdcard 已部署）
5. ~~测试/文档收尾~~ ✅（agent 24 项单测；README/HANDOVER 补 Rust 章节；修复 has_redirect/python-node 白名单）
6. 跨会话 reset 上下文：OpenClaw 工作区 MEMORY.md 持久方案
7. **双进程拆分（2026-08-06 完成）**：
   - agent 拆 lib + 双 bin：gca-agent（AI 通道，20 工具+审批，无会话）/ gca-term（人终端，会话化 exec 免审批 + interrupt/shell/ls/sysinfo/审计 + GCA_TERM_TOKEN 独立 + GCA_TERM_IDLE_MS 可配）
   - gca-server：/device/:name/term 代理 + 审计接收
   - gca-desktop：终端页指向 term、删会话生命周期、命令历史、注册入口（/register + 确认码审批 + /ops/:id 轮询）、登录页部署形态动态显示（纯控制端隐藏本机模式）
   - localmcp 双进程拉起
   - UI 临时可用即可（接口文档 docs/api.md 已写，UI 美化交给 MIMO）
   - 命名规范：产物 gca-desktop.exe / gca-agent.exe / gca-term.exe（目录名保留 desktop-rs/ agent/）
8. **构建部署验证 ✅（2026-08-06）**：
   - release 三 exe 构建通过；本机双进程拉起（3001 agent + 3011 term，独立 token）
   - VM gca-server 更新部署：本地 `cd server && npm run build` → `scp dist/* <SSH用户名>@<网关IP>:~/gca-server/` → `systemctl --user restart gca-server`（不碰 TestServer）
   - 代理链路全通：/device/gca-win11/mcp（initialize+sysinfo 与直连逐字节一致）、/device/gca-win11/term/exec（会话连续）、/term/ls
   - 注册流程端到端（UI 验证）：撤销 gca-win11 → desktop 显示「未注册」横幅 → 注册 → 确认码（推送飞书）→ 批准 → 设备恢复（openclaw.json 同步）

**托盘（2026-08-05 终版：Rust 原生 Win32，零脚本）**：`desktop-rs/src/tray.rs` 内嵌托盘线程——message-only 窗口 + Shell_NotifyIcon + 右键菜单（显示/退出），零依赖手写 FFI；单实例保护（FindWindowW）；关闭窗口（X/Alt+F4）→ 拦截（CancelClose）+ SW_HIDE 隐藏（进程后台常驻）；托盘「显示」→ EnumWindows 找本进程主窗口 + SW_SHOW + SetForegroundWindow（唤醒不重启）；「退出」→ EXIT_REQUESTED 原子 + WM_CLOSE（拦截放行优雅退出）。
**托盘退出 = 全套退出（2026-08-09）**：退出桌面端时一并 taskkill agent/term（localmcp::kill_local_services——agent/term 无独立 UI，不跟随退出则成无法管理的残留进程）；下次打开桌面端 localmcp 自动重新拉起。注意：退出后 VM 上 AI 将无法远程控制本机（设备服务未运行），重开桌面端即恢复。
**踩坑史**（勿回退）：
0. **终端子进程偶发 0xc0000142（Application Error 弹窗）**：ConPTY 拉起的 cmd/powershell
   偶发 DLL 初始化失败（CreateProcessW 成功但子进程 3 秒后退出）——独立启动正常、
   弹窗自 2026-08-08 终端上线即有、sideloaded OpenConsole 与 kernel32 conhost 都发生
   → 机器级注入干扰（本机 Tobii 眼动软件每 30 分钟崩溃循环 CLR20r3 + 杀软曾自动阻止
   gca-agent），非代码缺陷。**加固（2026-08-09）**：gca-term 启动 SetErrorMode
   （错误模式继承子进程 → loader 不再弹窗）+ Session.alive 死会话检测（读线程退出置
   假）→ get_or_spawn 自动换新会话（死会话不再挂空重连）。重启生效：
   `restart-gca-services.cmd`。Tobii 崩溃循环是机器环境问题，可用 tobii-aby-test.cmd
   做 A/B 实验判定（未证实是弹窗根因——AppInit_DLLs 关闭、Defender 无拦截记录）。
0a. **终端显示错位系列（2026-08-09~10 完整根因链，勿回退修复）**——症状：输入回显
    "倒数第二行"/PS 缩进 24/显示字符与 cmd 实际不一致（如输入 3.22 显示执行 2552）。
    根因链（每层独立修复，全部保留）：
    1) 渲染跳过**中间空白行**（dfd7051）→ 相邻行字符视觉拼接（"2s" 幽灵）→ 改只跳
       前导/尾部空白，中间渲染占位（app.rs show_term）
    2) resize 在 SSE 连接前设置、连接后不补发 → ConPTY 保持 100x30 → 加 flush 兜底
       （last_sent_size 不一致即补发）
    3) **gca-term 懒启动会话用默认 100x30，shell 在 100x30 下初始化后 resize → 行号
       偏移**（PSReadLine 内部 30 行逻辑，回显定位 \x1b[22;25H 超界 → vte clamp →
       "倒数第二行"+缩进）→ **SSE 连接 query 带尺寸**（?cols=X&rows=Y → 会话创建即
       用正确尺寸，Windows Terminal 同时序；desktop ensure_term 延迟一帧等网格就绪）
    4) **gca-server 代理 URL.pathname 赋值把 '?' 转义成 %3F** → 上游 404 → 无限重连
       "连接中" → termUrlFromEndpoint 拆 query 设 u.search（**已部署 VM 2026-08-10**）
    5) **切 shell（switch_shell）用默认 100x30 重建会话** → PS/cmd 又按 30 行初始化 →
       LAST_SIZE 静态记录最近 resize/SSE 校准尺寸，switch_shell 沿用（**已改代码，
       待重启生效 2026-08-10**）
    6) **★最终根因（2026-08-10）★ TermScreen 未实现 \x1b7/\x1b8（DECSC/DECRC
       保存/恢复光标）** → conhost 启动清屏（\x1b7 保存 1,1 → 逐行清 → \x1b8 恢复）
       后 TermScreen 光标停在清屏结束行（如 37）→ 后续 \r\n 把提示符写到视口外
       （行 38）→ 输入回显定位（\x1b[2;21H）写提示符行但提示符本身在别处 →
       全部症状（提示符消失/输入缩进 20-24/倒数第二行/显示字符错乱）源于此。
       验证：render_check 测试（收集真实字节 → TermScreen 渲染）——修复前
       "[01] 20空格+111"，修复后 "[01] D:\Yuzu-GCA-Service>111"。
       desktop 侧 CPR 应答（\x1b[6n→\x1b[1;1R 注入）也已删（OpenConsole 会应答
       真实位置，双应答干扰 PSReadLine——3012 注入对比验证差 1 行）。
    7) **★PS 错误后输入缩进 24（2026-08-11 定位）★ sideloaded conpty.dll +
       OpenConsole 作为 ConPTY 主机**导致 PSReadLine 错误输出后行号差 1
       （\x1b[10;25H 定位行 10 vs 提示符实际行 9）——wt 对照正常（wt 包里无
       conpty.dll，实际用系统 conhost）。3012 隔离对比：conhost 主机 cmd/PS
       全流程渲染完美（`>111`/`>dir`/`> sss`/`> ls` 提示符+输入同行）。修复：
       **默认系统 conhost（kernel32 CreatePseudoConsole）**，sideload 保留为
       GCA_CONPTY_SIDELOAD=1 开关（踩坑史 conhost 启动竞态若回归可切回）。
       注意：conhost 启动竞态需实际使用观察。
    验证方法：GCA_TERM_PORT=3012 起隔离实例 + curl SSE（带/不带尺寸对比）+
    输入 sss\r 后 grep 输出流里 \x1b[行;列H 定位是否超界（60x15 下应 ≤15 行）。
0b. **桌面端/脚本重启流程**：`restart-gca-services.cmd`（GBK+CRLF 编码——UTF-8/LF
    双击会被 cmd 按 GBK 解析吞换行闪退）→ taskkill desktop+agent+term → cargo build
    --release -p gca-agent -p gca-desktop-rs → start 桌面端。托盘退出 = 全套退出
    （kill_local_services，2026-08-09 用户明确要求）。
0c. **设备在线/显示链路（2026-08-11）**：
    - **DHCP IP 变动离线**：gca-server 有 /heartbeat（上报 machineId+port → 更新设备
      URL），但 agent-rs/desktop 从未调用（设计缺口）→ desktop 加心跳：登录即上报 +
      每 5 分钟（15s 刷新循环里），updated=true 时自动刷新设备列表
    - **离线探测卡顿**：共享 client connect_timeout 8s→2s、probe 请求 5s→3s
      （局域网设备响应 <100ms，超时都是离线）
    - **uptime 跳跃**：egui 空闲不重绘 → update 不运行 → 15s 刷新不触发 → 登录后
      每 1s request_repaint_after（1fps 轻量）
    - **uptime 每秒跳动**：DeviceRow 加 uptime_base+probed_at（探测校准 + 本地流逝
      叠加，任务管理器风格；agent 重启归零最多 15s 校准延迟）
    - **事件驱动方案**（服务器集中探测 + /events SSE 广播）——**2026-08-12 阶段一完成**
0d. **mDNS 发现三坑（2026-08-12，INT-004）**：
    1) **Windows 组播出口可能落在虚拟网卡**：默认路由虽指向物理网（<本机IP>），
       但节点 dgram / 0.0.0.0 绑定的 UDP socket 组播却从 172.29.x（WSL NAT）出包，
       组播不出物理网 → 收不到 VM 应答。修复：客户端**逐本机 IPv4 绑源地址建
       socket**（绑到具体 IP 即指定组播出口；std 无 set_multicast_if_v4，socket2
       才有）；node 端用 setMulticastInterface('<本机IP>') 验证。跨机实测：钉接口后
       本机 → VM <网关IP> 组播应答成功
    2) **客户端临时端口收不到组播应答**：mDNS 应答默认回组播 5353，绑 0 端口的
       查询方收不到。修复：查询带 **QU 位**（QCLASS=0x8001）→ 服务端单播回包到
       查询源端口（server mdns.ts 已实现，标准 DNS-SD 行为）
    3) **本机多 server 同时发布时"先到先得"会遮蔽目标**：本地测试 server
       （172.29 虚拟网）应答最快 → 实测时发现不到 VM → 验证时先停掉多余实例
0e. **审计推送（2026-08-12，INT-005）**：默认**不推送**（GCA_AUDIT_PUSH=1 才启用，
    本地留痕为默认）；agent 需 desktop 注入 GCA_SERVER_URL 才知道推送目标（此前
    agent 启动环境只有 token，无服务器地址）——重启桌面端后生效。端到端验证法：
    GCA_AUDIT_PUSH=1 + GCA_SERVER_URL=http://127.0.0.1:18791 起 agent → exec 只读
    命令 → server `GET /audit` 可见 deviceId=agent 的 exec 条目
      （docs/event-driven-plan.md）：server events.ts（状态表/探测循环/防抖/SSE 广播，
      9 单测）+ /events 端点 + heartbeat/revoke 联动；desktop subscribe_events +
      DeviceRow 分层（agent/term Option<bool>）+ 四态显示（在线绿/仅 Agent 黄/仅终端
      蓝/离线红/未知灰）+ 断线指数退避重连/轮询回退（8 单测）；44 测试全绿，VM 已部署
      实测（gca-win11 双在线 + Android 仅 Agent）；断线演练实机验证通过。
      已知遗留：devices_list 成功分支曾残留错误提示（已修复 51a4969）。
1. egui 的 ViewportCommand::Visible(false) 隐藏后事件循环停摆、命令失效
   （实测线程发 Close/Visible 均无响应）→ 不用 egui 隐藏，用 **Win32 SW_HIDE**：
   egui/winit 以为窗口仍可见 → 事件循环活跃，SW_SHOW 唤醒后状态一致
   （实测 5 步循环全过：隐藏→唤醒→再隐藏→再唤醒）
2. SW_RESTORE 对隐藏窗口无效（不设 WS_VISIBLE），恢复必须 SW_SHOW
3. PS scriptblock delegate 的 $script: 作用域赋值失效 + QueryFullProcessImageNameW
   经 PS 只回传 1 字符 → 窗口查找最终用纯 C#/Rust FFI（托盘 Rust 化后彻底绕开）
4. Rust 回调传参不能用 lparam 打包指针（x64 左移溢出截断 → 写坏内存崩溃）→
   static AtomicU32/AtomicUsize 传 PID/结果
5. PowerShell 5.1 坑：DETACHED_PROCESS 立即退出、param 不能叫 $pid、
   无 BOM 按 ANSI 读中文炸、wmic 输出 UTF-16（bash grep 失配）——托盘脚本已废弃
验证：托盘消息窗口存在（FindWindowExW HWND_MESSAGE 类名 GcaTrayWindow）、
单实例、隐藏/唤醒循环、WM_COMMAND ID_EXIT 退出（全自动实测通过）。

## 5. 环境速查

- VM：`ssh <SSH用户名>@<网关IP>`（免密）；gca-server 重启 `systemctl --user restart gca-server`；服务端 token 在 `~/<服务端token路径>`（64 hex）；openclaw.json 在 `~/.openclaw/openclaw.json`
- Android：adb 设备 `<ADB序列号>`（<Android设备IP>）；打包 `client` tsc → esbuild（带 crypto banner）→ `android/` gradlew assembleDebug → adb install
- 本机 agent 日志：`%APPDATA%\GCA Desktop\gca-poc.log`；desktop-rs 凭据：`%APPDATA%\GCA Desktop\config.json`
- 工具测试端口：3001 被 agent 占用时用 `GCA_AGENT_PORT=3002` 起测试实例
