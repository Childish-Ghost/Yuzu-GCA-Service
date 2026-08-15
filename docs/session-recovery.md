# 跨会话进度恢复指南（Session Recovery）

> 2026-08-11 整理 · 新会话/上下文压缩后，如何快速识别项目进度、接着上次继续干

## 1. 唤醒后的第一步（30 秒内）

```
1. 读 GCA-MASTER.md（根目录，总纲）——全貌/状态/关键决策/待办/命令
2. 读 docs/project-status.md —— 踩坑史（已修复的问题根因，避免重复踩）
3. 看下方"进度锚点"确认上次做到哪
```

> 记忆文件（`~/.claude/projects/D--Yuzu-GCA-Service/memory/`）由 Claude 自动加载，
> 含关键偏好（协作风格/进程归属/终端修复链/归档状态）——无需手动读。

## 2. 进度锚点（按顺序确认）

| # | 锚点 | 位置 | 确认什么 |
|---|------|------|---------|
| 1 | **待办清单** | GCA-MASTER.md 第八节 | 当前优先级最高的任务（Win7 浏览器终端 / Android 原生化 / 事件驱动…） |
| 2 | **未提交改动** | `git status` | 工作区 40+ 文件改动（修复链 + 归档 + 文档）——**是否已提交** |
| 3 | **未生效项** | `ls -la target/release/*.exe` 时间戳 vs 代码改动时间 | release 二进制是否落后于源码（审查修复 2026-08-11 未重启生效） |
| 4 | **服务状态** | 见下方命令 | agent/term/server 是否在跑、设备是否在线 |
| 5 | **最近日志** | `%APPDATA%\GCA Desktop\logs\` | 上次会话结束时的状态（desktop.log 尾部） |

## 3. 状态速查命令（一条命令看清全貌）

```bash
# 进程与端口
tasklist | grep -iE "gca-"
netstat -ano | grep -aE ":3001|:3011"

# release 版本（与源码改动时间对比——落后则需重启）
ls -la target/release/gca-agent.exe target/release/gca-term.exe target/release/gca-desktop-rs.exe

# 本机健康
curl -s http://127.0.0.1:3001/health && curl -s http://127.0.0.1:3011/health

# 设备注册表（IP 是否正确——心跳是否生效）
curl -s -H "Authorization: Bearer <token>" http://<网关IP>:18790/devices

# 最近日志（上次会话结尾）
tail -20 "%APPDATA%\GCA Desktop\logs\desktop.log"
```

## 4. 恢复检查清单（新会话第一件事）

- [ ] 读 GCA-MASTER.md（全貌 + 待办）
- [ ] `git status`——未提交改动是否还在（上次没提交的话，先确认再动代码）
- [ ] release 二进制时间戳 vs 源码——**审查修复（scroll_up/焦点门控等）是否已重启生效**
- [ ] 本机 agent/term 健康（3001/3011）
- [ ] 设备列表（gca-win11 / Android 在线状态）
- [ ] 用户上次说的下一项任务（MASTER 待办 P1：Win7 浏览器终端）

## 5. 常见"上次做到哪"对照

| 上次会话结尾状态 | 特征 | 接着做什么 |
|------------------|------|-----------|
| 修复链未提交 | git status 大量 M | 确认修复完整性 → 提交 → 重启验证 |
| 审查修复未重启 | release 时间戳 < 源码改动 | 跑 scripts/restart-gca-services.cmd → 验证滚动/焦点 |
| 待办指向某任务 | MASTER 第八节 | 直接开工（方案已在 MASTER/文档里） |
| 设备离线 | /devices URL 与 IP 不符 | 等心跳 / 手动 heartbeat / fix-firewall |

## 6. 文档地图（快速定位）

| 想找什么 | 读哪 |
|---------|------|
| 项目全貌/决策/命令 | GCA-MASTER.md |
| 已修问题的根因（防重复踩坑） | docs/project-status.md 踩坑史 |
| 接口定义 | docs/api.md |
| 对话↔账户↔设备关联 | docs/account-linking.md |
| 历史设计/审批协议 | docs/gap-v2.md、docs/flow.md 等 |
| 过期内容 | archive/（只读参考） |
