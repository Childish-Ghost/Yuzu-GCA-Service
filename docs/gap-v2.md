# GAP-v2 审批协议（GCA Approval Protocol v2）

> 状态：**全链路已上线并实测通过（2026-07-25）** · 模式：微软 Authenticator 推送模式 · 飞书/微信即"Authenticator App"（零新 App 开发）
> ⚠️ **历史协议标注（2026-08-12 审查 D4）**：本文档是 GAP-v2 设计稿——3 位 nonce 方案。
> 现行实现已演进为：设备本地确认 = 6 位 32 字母表 confirmToken（node/rust 一致）；
> gca-server ops = 6 位十进制确认码（飞书/微信推送）。nonce 模型（带外送达、本地校验、
> AI 永不被信任）仍是现行设计原则。
>
> 实测记录：power restart → 推送双通道送达 → 用户回复 nonce 857 → 设备本地校验执行（排程 600s）→ abort 取消 → shutdown /a 物证无排程

## 1. 角色

| 角色 | 承担 | 类比 |
|------|------|------|
| **Gateway 中继**（gap-relay，VM 侧独立小服务，systemd `gap-relay.service`） | 接收设备推送请求，`openclaw message send` 双通道直发（202 异步投递） | 微软云 |
| **Owner 通道** | 飞书/微信（allowlist 锁定的 owner 账号） | Authenticator App |
| **设备（MCP Server）** | 产生待确认操作、生成 3 位 nonce、**本地校验**后执行 | 登录页 |
| **AI 模型** | 传话员——转发 nonce/结果，**永不被信任** | 不可信网络 |

## 2. 核心流程（已实现）

```
1. 设备创建待确认操作（power/service 高危操作）
   → pending 生成一次性 3 位 nonce（AI 不可见）
2. 设备 → gap-relay POST /push（Bearer 配对 token）
   → relay 202 秒回 ACK，后台异步投递
3. Owner 在飞书+微信同时收到：
   "【GCA 审批】设备 X 请求执行 <opDetail>，批准请直接回复数字 NNN"
4. Owner 回复 NNN → AI 调 confirm(NNN)
5. 设备本地校验 nonce（一次性 + 5min TTL + 错 3 次烧毁操作）→ 执行
```

设计简化（2026-07-25 实施时确认）：**无需 Gateway 见证/求证**——nonce 设备生成、带外送达、本地校验，与 TOTP 同模型，AI 只能转述无法伪造。

## 3. 安全性质

| 威胁 | 防御（已实测） |
|------|------|
| AI 伪造 nonce | nonce 只在设备直发的推送里，不进 AI 上下文；confirm 响应不含码 |
| AI 篡改操作描述 | 推送由设备经 relay 直发，Owner 所见即真实 opDetail |
| 习惯性盲批 | 数字匹配：必须读出推送里的数字才能回复 |
| 暴力猜 nonce | 3 位数字 × 3 次尝试即烧毁操作（0.3% 每操作），日志告警 |
| 局域网扫端点 | 配对 token Bearer 认证（relay /push + 设备 /mcp 双双启用） |
| 重放 | nonce 一次性 + 5 分钟 TTL + 执行后作废 |

## 4. 降级链（全部已上线）

1. **GAP 推送**（relay 可达）— 主路径
2. **TOTP Authenticator** — relay 不可达 + 已配置
3. **桌面弹窗码**（msg.exe）— 前两者均不可用，Owner 在设备旁

## 5. 运维

- relay 部署：`~/gap-relay/server.mjs`（VM），systemd `gap-relay.service`，端口 18790，token 在 `~/<服务端token路径>`（与设备配对 token 相同）
- relay 的 openclaw CLI 冷启动慢（20-60s），必须 202 异步投递 + execFile timeout 90s（30s 曾被掐死过一次）
- 设备端 `GAP_RELAY_URL` 可覆盖中继地址（默认 http://<网关IP>:18790）；测试一律指向死端口防幽灵推送

