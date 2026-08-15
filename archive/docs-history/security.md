# 可行性与安全性分析

> 基于 OpenClaw + MCP 架构的技术验证与风险评估

| 评估 | 数量 |
|------|------|
| 整体可行 | ✓ |
| 高风险 | 3 |
| 中风险 | 4 |
| 低风险 | 2 |

## 技术可行性

| 评估项 | 结论 | 依据 |
|--------|------|------|
| Gateway MCP Host | 可行 | OpenClaw 原生支持 mcpServers 配置，自动发现 MCP Tools |
| 客户端 MCP Server | 可行 | @modelcontextprotocol/sdk 成熟，SSE/WS 传输 |
| 远程桌面推流 | 需要适配 | screenshot-desktop + Sharp + WS，跨平台有差异 |
| UI 自动化 | 平台差异大 | Windows UIAutomation / Linux AT-SPI2 / macOS AX API 三套 |
| 外网访问 | 可行 | Tailscale + DDNS-GO 已验证可用 |

## 高风险项

::: danger 远程命令执行 — 命令注入
客户端暴露 exec MCP Tool，AI 被 prompt injection 攻击可能执行恶意命令。

**缓解：** 三级审批机制（已落地，见下方专项）；沙箱模式（Phase 2+）。
:::

### exec 三级审批机制（已确认方案 · POC 已实现 ✅）

目标：**AI 正常执行只读命令无感知，写入/删除/网络操作需用户确认，危险命令直接拦截**。POC 已实现 `classifier.ts`（命令分类）+ `approval.ts`（审批决策）+ `executor.ts`（执行），56 个单元测试覆盖。

| 级别 | 处理 | 命令示例 |
|------|------|----------|
| **第一级：只读白名单** | 自动通过，零打扰 | `dir, ls, cat, tail, head, grep, find, type, echo, df, du, ps, tasklist, systeminfo, whoami, hostname, ipconfig, ifconfig, netstat, ping` |
| **第二级：写操作** | 返回 `confirmation_required`，用户在聊天通道回复"允许"才执行 | `move, copy, del, rm, mkdir, rmdir, touch, chmod, chown, systemctl stop/start, docker stop/start, git push, npm install` |
| **第三级：危险命令** | 直接拦截，返回 `blocked` 并记录安全日志 | `format, fdisk, dd, mkfs, shutdown/reboot`（须走 power Tool）, `rm -rf /`, fork bomb, `curl\|bash`, `wget\|bash` |

**用户体验：** 90% 日常操作（查文件、看日志、查磁盘）走白名单无感通过。POC 阶段 write 命令只返回 `confirmation_required` 不实际执行，Phase 1 对接聊天通道完成确认闭环。

::: danger 远程桌面 — 未授权访问
屏幕推流 + 鼠标键盘直通 = 完全控制。连接被劫持则设备沦陷。

**缓解：** 控制/数据平面分离架构（已确认方案）——控制平面走 Gateway：验证身份权限 → 签发短期 session token（TTL 5 分钟、单次使用、绑定源/目标 IP）→ 记审计日志；数据平面直连：目标设备验证 token 后才推流。Gateway 不看数据内容，但记录「谁连了谁、什么时候、持续多久」。Tailscale 加密隧道；远程控制需被控端确认。
:::

::: danger Prompt Injection — AI 被劫持
不受信内容（网页、邮件、文件）携带恶意指令，操纵 AI 执行危险操作。

**缓解：** 使用旗舰模型；不受信内容用只读 reader agent 预处理；高风险工具走 approval。
:::

## 中风险项

::: warning Gateway Token 泄露
客户端存储 Gateway 认证 token，泄露则未授权设备可接入。

**缓解：** token 存储在系统 keychain；定期轮换；Gateway 侧可撤销已知设备。
:::

::: warning 剪贴板数据泄露
跨设备剪贴板同步可能无意中传输密码、token。

**缓解：** 敏感模式检测；同步后自动清除远端剪贴板。
:::

::: warning Gateway 单点故障
Gateway 挂掉导致所有设备失联、所有通道中断。

**缓解：** launchd/systemd 守护进程自动重启；健康检查告警。
:::

::: warning 外网暴露攻击面
Tailscale/DDNS-GO 暴露 Gateway 到外网，可能被扫描攻击。

**缓解：** Gateway auth token 必须设置；Tailscale 本身有加密；定期安全审计。
:::

## 低风险项

::: info 配置文件安全
客户端本地存储 Gateway token、Headscale 密钥等凭据。

**缓解：** 使用系统 keychain 存储凭据；不写入明文配置文件。
:::

::: info 第三方依赖漏洞
systeminformation/screenshot-desktop/@modelcontextprotocol/sdk 等 npm 包可能存在安全漏洞。

**缓解：** npm audit 定期检查；锁定版本；关键依赖 fork。
:::

## 可复用的 OpenClaw 安全机制

| 机制 | 说明 |
|------|------|
| 设备配对 | challenge 签名 + 人工审批，防止未授权设备接入 |
| 工具策略 | per-agent allow/deny 列表，AI 只能看到被允许的 Tools |
| Exec Approval | 命令执行审批机制，allowlist + 每次确认 |
| 沙箱模式 | Docker 容器隔离工具执行，限制文件系统和网络访问 |
| 安全审计 | openclaw security audit 自动检查配置风险 |
| 会话隔离 | dmScope: per-peer，不同用户上下文隔离 |
