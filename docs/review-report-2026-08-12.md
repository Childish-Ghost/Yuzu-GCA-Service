# GCA 全代码进程审查报告 · 2026-08-12

> **范围**：server / client（node TS）/ agent（rust）/ desktop-rs（rust）当前工作区（含未提交改动）；**android 排除**（未重构）
> **方法**：探索审查（3 代理）→ 需求追溯 RA6（51 条设计条目）→ 对抗验证（2 代理 16 项，独立尝试驳倒）→ 全量修复 → 构建测试 + S1 集成验证
> **基线**：git 830e105 之后的工作区改动；设计基线 = docs/architecture.md / docs/api.md / GCA-MASTER 决策 13 条

## 一、摘要

| 项 | 数 | 说明 |
|---|---|---|
| 修复 | **44 项** | 服务端安全 15、客户端冲突/安全 14、功能补齐 4、文档偏差 8、测试基建 3 |
| 对抗验证驳回 | **1 项** | S11（dashboard 撤销按钮 "SyntaxError" 论断——按钮实际可用，corner case 仍修） |
| 确认 | **15 项** | 服务端 7 / 客户端 8，无一存疑 |
| 遗留已知问题 | **7 项** | 见 §七 |
| 测试 | 全部绿 | server 25 / client 7 / agent 35+2 / desktop 19；新增 mdns 畸形包 7、SSRF 矩阵 2、classifier 6、pending 5、S1 集成 21 |

**最高优先修复（S1）**：设备配对曾直接拿到 owner 管理 token（`pairing.ts:47` 写注册表 + 响应原样返回）——已配对设备可自批审批、铸新码、撤销他人。现改为**设备自铸 token**（≥32 字符），服务端只存储；设备端点（heartbeat/audit/clipboard/ops/注册轮询）按设备 token 认证，owner 端点隔离。S1 集成验证 21 项全过（见 §九）。

## 二、发现清单总表

| 编号 | 维度 | 组件 | 严重度 | 位置 | 问题 | 状态 |
|---|---|---|---|---|---|---|
| S1 | 安全 | server | **CRITICAL** | pairing.ts:47-48, devices.ts:87, gca-server.ts:798 | 设备 token = owner token，授权坍缩 | ✅ 已修（§三.1） |
| S2 | 安全 | server | **CRITICAL** | gca-server.ts:770-772 | /clipboard/latest 无鉴权 | ✅ 已修 |
| S3 | 安全 | server | **CRITICAL** | gca-server.ts:539-559 | SSRF：IPv4-mapped/DNS 名绕过（实测可通） | ✅ 已修（§三.2） |
| S4 | 安全 | server+desktop | **CRITICAL** | mdns.ts:72-95 / mdns.rs:96-131 | 畸形 mDNS 包死循环 → HTTP 全停 | ✅ 已修 + 7 回归用例 |
| S5 | 安全 | server | LOW | mcp.ts:204-206 | 明文 === 比对（时序侧信道） | ✅ 已修（consttime.ts） |
| S6 | 安全 | server | **CRITICAL** | gca-server.ts:588,781,873 | 无限流 + 确认码可暴力 + 码值明文日志 | ✅ 已修（rateLimit.ts + 烧码 + 脱敏） |
| S7 | 安全 | server | HIGH | cli.ts:110-126 | systemd ExecStart 路径不存在；token 明文入 unit(644) | ✅ 已修（dist 路径 + token.env 0600） |
| S8 | 安全 | server | **CRITICAL** | gca-server.ts:464,765 | 剪贴板 5MB 声明 vs 64KB 实际上限，超限清空 | ✅ 已修（专用上限 + 413 不清空） |
| S9 | 冲突 | server | MEDIUM | gca-server.ts:621-626 | revoke 不解码（rename/reurl 解码）→ 中文名撤销 404 | ✅ 已修 |
| S10 | 冲突 | server | HIGH | pairing.ts:47, devices.ts:94 | 配对不写 machineId → 心跳 404 断链；死代码 | ✅ 已修（配对带 machineId + 名称兜底 + 删死代码） |
| S11 | 功能 | server | MEDIUM→LOW | gca-server.ts:356 | 撤销按钮模板（**对抗验证驳回 SyntaxError 论断**；escJs 把 `/`→`\` 的 corner case 属实） | ✅ 已修（data-name 方案） |
| S12 | 安全 | server | MEDIUM | gca-server.ts:321 | escJs 双转义语义损坏（/ → \） | ✅ 已修（escJs 删除） |
| S13 | 安全 | server | MEDIUM | openclaw.ts:321,386 | agent-key.json 私钥明文无权限收紧 | ✅ 已修（chmod 600；Windows 记遗留） |
| S14 | 功能 | server | LOW | events.ts:230-235, ops.ts:109 | 定时器不 unref，close 后进程不退出 | ✅ 已修 |
| S15 | 安全 | server | MEDIUM | gca-server.ts:638, mcp.ts:249 | rename 无名称校验；notification 带 id 响应 | ✅ 已修 |
| C1 | 安全 | client | **CRITICAL** | classifier.ts:28,31 | curl/wget/node/python 免确认（rust 已修未同步） | ✅ 已修 + 6 单测 |
| C2 | 安全 | client | **CRITICAL** | transfer-fetch.ts:12-14 | 票据 URL 无 host 校验（任意主机免确认写盘） | ✅ 已修（本机校验） |
| C3 | 安全 | agent | **CRITICAL** | confirm.rs:23, pending.rs:29 | confirm 忽略 token + 队列无上限 → 无确认执行链 | ✅ 已修（token 精确消费 + MAX=100） |
| C4 | 冲突 | agent | MEDIUM | power.rs:27 vs power/handler.ts:59 | power 双授权路径（本地 confirm / 远程 ops） | 📋 文档标注（部署互斥） |
| C5 | 安全 | client | HIGH | transfer-fetch.ts:27 | 下载无大小上限（rust 512MB） | ✅ 已修（流式 + 512MB） |
| C6 | 安全 | agent | HIGH | exec.rs:236-239 | stderr 无界读 OOM（rust 只修了 stdout） | ✅ 已修 |
| C7 | 冲突 | agent | MEDIUM | pending.rs:29 | 待确认队列无上限（node 100） | ✅ 已修 |
| C8 | 冲突 | 全部 | LOW | mcp.rs:33, sse-transport.ts:51 | 版本号与 manifest 不符 | ✅ 已修 |
| C9 | 冲突 | desktop | LOW | architecture.md:44, localmcp.rs:218 | term token "隔离"声明与实现矛盾 | 📋 文档更正，二期轮换 |
| C10 | 冲突 | desktop | HIGH | localmcp.rs:253-257 | 按镜像名 taskkill 误杀；无 PID 记录 | ✅ 已修（自管 PID + 标记清理） |
| C11 | 冲突 | client | LOW | types/tools.ts:16-31 | TOOL_NAMES 13 vs 注册 20；wol 超实现 | ✅ 已修 |
| C12 | 冲突 | desktop | MEDIUM | localmcp.rs:176,217 | GCA_DEVICE_NAME 硬编码 gca-win11 | ✅ 已修（hostname 派生） |
| C13 | 安全 | agent | HIGH | conpty.rs:598 | 终端输入明文落盘（密码泄露） | ✅ 已修（只记长度） |
| C14 | 安全 | agent | HIGH | confirm.rs:23 | 无 token 可确认最近操作 | ✅ 已修（含 D4） |
| C15 | 安全 | agent | LOW | gca-agent.rs/gca-term.rs | 开放模式无警告 | ✅ 已修 |
| C16 | 安全 | desktop | MEDIUM | login.rs:51-57 | token 明文 config.json | ✅ 最小修复（ACL 收紧）；完整方案记遗留 |
| C17 | 功能 | agent | MEDIUM | tickets.rs:50-68 | 票据 RNG 依赖 PowerShell 子进程，失败即不可用 | ✅ 已修（降级熵源） |
| D1-D8 | 关联 | docs | — | 各文档 | 文档-代码偏差 8 项 | ✅ 已修（§五） |
| F1 | 功能 | server | MEDIUM | gca-server.ts:638 | rename 广播 hook 缺失（RA6 唯一"缺失"项） | ✅ 已修 |
| F2 | 功能 | server | HIGH | mcp.ts:157 | register_device deviceIp 硬编码 'mcp' → URL 无效 | ✅ 已修（owner 提供） |
| F3 | 功能 | agent | LOW | exec.rs:305 | truncated 恒 false | ✅ 已修 |
| F4 | 功能 | agent | HIGH | file_ops.rs:218 | file_read 无字节上限 OOM | ✅ 已修（1MB + 标志） |

## 三、安全维度（S 节）

### 3.1 S1 设备 token 隔离（本轮最大设计变更）

**缺陷链（对抗验证确认）**：`/pair/claim` 把 `serverConfig.token` 原样返回给设备（pairing.ts:48）并写进 openclaw.json（devices.ts:87）；`/ops/approve`（gca-server.ts:798）与 MCP `approve_op`（mcp.ts:137）注册设备时同样传 owner token → **设备凭据 = owner 凭据**。已配对设备可调 `/pair/init`、`/ops/approve`、`/devices/:name/revoke`、`/push`、读审计。

**修复设计**（token 由设备侧铸造，服务端只存储）：

```
设备铸造 deviceToken（≥32 字符，复用 client generatePairingToken）
  → /pair/claim 或 /register 携带 → 服务端写入 openclaw.json
  → 三重角色：Gateway→设备 MCP 凭据 / 设备→server 认证 / 代理转发凭据
```

- **server**：devices.ts 存 `deviceToken` 字段 + `findDeviceByToken`/`updateDeviceToken`（retoken 端点）；`registerDevice` 拒绝缺 token；新增 constant-time `tokenEqual`（consttime.ts）；端点鉴权矩阵见 gca-server.ts 头注释——`/heartbeat`（按 machineId/名称定位后比对）、`/audit` POST（deviceId 服务端覆盖）、`/clipboard/*`、`/ops/request`（device 字段认证身份覆盖）、`GET /ops/:id`（归属校验）、`/register`（owner 带码 / 设备通道受理格式合法 token，信任闸门 = owner 审批）、新增 `GET /device/me` 自查询
- **M6 一并修**：`GET /ops/:id` 与设备通道 `register/ops/request` 响应**不再含确认码**——码只走 owner 通道（飞书/微信推送 + dashboard）；MCP `register_device` 工具同样去码 + 补 `deviceIp` 参数
- **client**：新增 device-token.ts（env `GCA_DEVICE_TOKEN` → settings `security.deviceToken` → 过渡回退 MCP token → 铸造持久化）；注册检查改 `GET /device/me`；heartbeat/audit/clipboard/ops 全用设备 token；`gca pair` 保存 deviceToken 并同步为 MCP token（保证 Gateway 接入）
- **desktop**：config.json 增 device_token（零依赖熵源铸造）；`ensure_running` 注入 `GCA_DEVICE_TOKEN`；server 模式注入 GCA_MCP_TOKEN=deviceToken，本机模式注入登录 token（直连语义）；heartbeat 用设备 token
- **agent**：audit.rs 推送 Bearer 优先 `GCA_DEVICE_TOKEN`

**迁移说明**：老注册表条目（无 deviceToken 或 = owner token）→ 设备端点 401 → 需重新配对/注册（owner 侧可用 `POST /devices/:name/retoken` 自助换发）。部署按 server→client→desktop 顺序更新。

### 3.2 S3 SSRF 修复算法

`safeUrl` 重写（gca-server.ts）：字面 IPv4 查 9 类保留段；字面 IPv6 拒绝 ::1/::/fe80/fc/fd/ff + **IPv4-mapped 解映射**（点分 `::ffff:127.0.0.1` 与十六进制 `::ffff:7f00:1` 两种形态均解析出 IPv4 再判——堵住实测绕过）；DNS 名 `dns.promises.lookup(all:true)` 逐地址校验、解析失败 fail-closed。ssrf.test.ts 17 项绕过矩阵全拦。**已知限制**：DNS 重绑定 TOCTOU（解析后到连接前 IP 可变）——记录遗留，不做二次连接校验（改动面过大）。

### 3.3 S4 mDNS 防死循环

双端同修：server mdns.ts decodeName + desktop mdns.rs decode_name——压缩指针**必须严格指向前方**（`ptr < pos`）、跳转上限 32、访问前越界检查、名称 ≤255 字节。mdns.test.ts 新增 7 个畸形包用例（自引用指针/截断 label/截断指针/越界指针/前向指针/指针环/超长名）全部有限时间返回。

### 3.4 其余 S 项要点

- **S6**：新增 rateLimit.ts 滑动窗口（pair/claim 10/分/IP、pair/init 30/时/IP、ops/approve 60/分/IP + 全局 300/分、register 10/时/IP）；`approveOp` 单码错 5 次烧毁；码值日志只记后 2 位（`code:****PH`）
- **S8**：/clipboard/push 专用读取上限（5MB+4096），超限 413 且**不触碰现有内容**（此前 readJson 吞错返回 {} → 空串覆盖清空）
- **S2**：/clipboard/latest 改 owner|device 双通道认证；client 拉取补 Bearer

## 四、冲突维度（C 节）——双实现对比矩阵

| 行为 | node client | rust agent | 结论 |
|---|---|---|---|
| curl/wget/node/python 审批 | ✅ 已同步（需确认） | ✅ 已修（2026-08-11） | 一致 |
| 票据 URL host 校验 | ✅ 已同步（本机） | ✅ 本机基址/127.0.0.1 | 一致 |
| 下载上限 | ✅ 512MB 流式 | ✅ 512MB | 一致 |
| confirm 协议 | token 精确消费 + 裸确认排除 power | ✅ 已对齐（consume + 裸确认排除 Power） | 一致 |
| 待确认队列上限 | 100 | ✅ 100 | 一致 |
| exec stdout/stderr 截断 | 1MB 双路 | ✅ 1MB 双路 + truncated | 一致 |
| 确认 token 字母表 | 32 字母表 × 6 位 | ✅ 同表 | 一致 |
| server ops 确认码 | — | 6 位十进制（**与确认 token 是两套系统**——F8 确认，文档已标注 D4） | 记录 |
| power 审批路径 | gca-server 远程 ops | 本地 pending+confirm | 📋 部署互斥，文档标注 C4 |
| term token 隔离 | — | 默认同 token | 📋 文档更正 C9，二期轮换 |
| 版本上报 | ✅ 0.3.0 | ✅ 0.1.0 | 一致 |
| 设备名派生 | hostname 小写净化 | ✅ desktop 同规则 | 一致 |

## 五、关联性维度（D 节，文档偏差修正）

- **D1** api.md ops/request 字段 → `{operation, detail}`（响应无 code）
- **D2** "22 工具" → 20（GCA-MASTER/architecture/README/HANDOVER/releases 共 6 处）
- **D3** chat_ai 补表（注明为管理 MCP 工具非 REST 端点）
- **D4** gap-v2.md 顶部加历史协议标注（3 位 nonce 设计稿 vs 现行 6 位确认码/32 字母表 token）
- **D5** 测试数统一（README/HANDOVER 标注以 GCA-MASTER 49 为真值）
- **D6** device-identity.md localStorage → config.json（+ device_token 字段说明）
- **D7** README/HANDOVER 更新（20 工具、新能力、测试命令）
- **D8** 版本矩阵（§八）按 versioning.md 双版本模型

## 六、功能符合度（F 节，RA6 需求追溯）

51 条设计条目：**完整 37 / 部分 10 / 缺失 1 / 超实现 3**。修复 4 项（§二 F1-F4）；超实现 3 项为 `wol`（node-only，已标注）、mDNS 发布（决策 13 落地）、审计挂钩（决策 12 落地）——均非缺陷。已知限制排除：scrollback 不渲染、256 色映射、只 term 设备盲区、term 端口+10 推断、Android P1、backlog P2 池（均已记录在案）。半成品检测：全仓 0 TODO/FIXME/unimplemented!，未提交新文件（audit.rs/mdns.rs/mdns.ts）均为完成态。

## 七、遗留已知问题（修复面过大，建议排期）

1. **C4** power 双授权路径——部署互斥（desktop 优先 rust exe），文档已标注，暂不统一
2. **C9** term token 彻底隔离——需 devices.ts 存 termToken + 代理换头，跨 3 组件；二期轮换
3. **C16 完整方案**——desktop config.json 改 DPAPI/wincred 加密存储（本次仅 ACL 收紧）
4. **S13 Windows 侧**——POSIX chmod 600 在 Windows 无效，需 ACL 处理
5. **S3 DNS 重绑定 TOCTOU**——解析后到连接前 IP 可换
6. **注册表竞态**——openclaw.json 读改写非事务（M7 记录在案）
7. **客户端测试基建**——client 仅 classifier 单测（本轮新增）；E2E 待补

## 八、版本矩阵（修复后实测）

| 组件 | manifest 真值 | MCP 上报值 |
|---|---|---|
| server | 0.3.0 | 0.3.0 ✓ |
| client | 0.3.0 | 0.3.0 ✓（两 transport） |
| agent+term | 0.1.0 | 0.1.0 ✓ |
| desktop-rs | 0.3.0 | — |

## 九、验证执行记录

```
server:   npm run build ✓ + node --test dist/ = 25/25（mdns 畸形包 7 + events 16 + SSRF 2）
client:   npm run build ✓ + npm test = 7/7（classifier 对齐 rust 用例集）
agent:    cargo test -p gca-agent = 35+2/35+2（pending 5 新增；测试串行锁修复竞态）
desktop:  cargo test -p gca-desktop-rs = 19/19（含 1 预置 ignore）
S1 集成:  scripts/verify-s1-token-isolation.mjs = 21/21（可复用回归）
```

S1 集成覆盖：claim 响应无 pairingToken、注册表写入设备 token 非 owner、heartbeat 设备 200/owner 401、register 双通道码语义、GET /ops/:id 无 code、clipboard 鉴权 + deviceId 覆盖、audit 身份覆盖、设备 token 调 owner 端点 401。

**用户手动验证脚本**（GBK+CRLF，双击运行）：`scripts/verify-dashboard.cmd`（撤销按钮 + 中文设备名）、`scripts/verify-kill-scope.cmd`（退出清理范围）、`scripts/verify-mdns-discovery.cmd`（跨机 mDNS + S4 畸形包）。

**对抗验证记录**：服务端 8 项——F1-F7 确认（S1 token 坍缩、S2、S3 实测、S4、S6、S8 实测、S10），**F8 驳回**（撤销按钮 "SyntaxError" 论断不成立——`\'` 在脚本字符串字面量内是合法转义，按钮实测可点；但 escJs `/`→`\` 与引号 corner case 属实，仍修复）；客户端 8 项——F1-F8 全部确认（C1 免确认链、C2+C5 票据、C3+C7+C14 无确认执行链、C6 stderr、C13 输入落盘、C10 镜像名杀、C12 硬编码、C2b 两套 token 系统）。
