# 审查会话规范（安全 + 软件审查基线）· 2026-08-15

> 用途：**审查会话**（新会话压缩上下文后 / 双 agent 审查）先读本文件 + `GCA-MASTER.md`，
> 即可恢复当前安全基线、既定决策、已知泄露、软件审查维度、必跑检查与发布红线。
> ⚠️ 本文件**不含任何明文密钥**——泄露值一律以「类型 + 掩码 + 位置」记录，避免二次入库。

## 一、双仓库发布模型（红线，勿回退）

| 仓库 | 性质 | 历史 | 脱敏 | 发布方式 |
|------|------|------|------|----------|
| gitea `git.childish-ghost.com/LukeMackin/Yuzu-GCA-Service` | 私有 | 完整历史（含历史泄露） | **不需要** | `git push origin main` 直接推 |
| GitHub `github.com/Childish-Ghost/Yuzu-GCA-Service` | 公开 | **仅干净 B0.5.0 单根提交** | **必须干净** | 干净根提交（见下方红线：`git commit-tree` + `git push -f github <root>:main`，无固定脚本） |

**红线**：
- ⚠️ **禁止 `git push github main`** —— 会把本地完整（含泄露）历史推上公开 GitHub。
- **环境/部署信息只进 gitea，不进 GitHub**：VM IP、ssh 账号、adb serial、token 文件路径、内网拓扑等「给 agent 配置的工作环境」属私有记忆，发布到 GitHub 前必须从发布树脱敏（GCA-MASTER §五/§六 及 docs 里散落的内部 IP 等）。
- GitHub 每次发布必须走「干净根提交」方式：`git commit-tree` 造无父提交，只带脱敏树，然后 `git push -f github <root>:main` + 重打 tag。
- gitea/本地 tag 已统一改为 **B 前缀**（2026-08-15 起全部降级为 B 通道 beta）：`B0.2.0` / `B0.3.0` / `B0.4.0-beta.1/2/3` / `B0.5.0`（原 `v` 前缀 tag 已删除）。
- GitHub 只保留当前版本 tag（`B0.5.0`）；旧 tag（v0.2.0 / v0.3.0 / v0.4.0-beta.1/2/3）已删除，不要再补。
- 本地 `B0.5.0` tag 指向 gitea 原提交（`261b050`，私有不脱敏）；GitHub 侧 `B0.5.0` 指向干净根提交（`adc03311`，已脱敏单根）。二者是**两个独立 ref**。

### 环境脱敏替换表（发布 GitHub 前对发布树执行；gitea 保留真实值）

| 原值 | 占位符 |
|------|--------|
| `<网关IP>` | `<网关IP>` |
| `<Android设备IP>` | `<Android设备IP>` |
| `<本机IP>` / `<本机IP>` / `<本机IP>` | `<本机IP>` |
| `172.29.x.x` | `<虚拟网IP>` |
| `<ADB序列号>` | `<ADB序列号>` |
| `<SSH用户名>@` | `<SSH用户名>@` |
| `<服务端token路径>` | `<服务端token路径>` |
| `<服务端token环境文件>` | `<服务端token环境文件>` |

- 实现：Node 脚本**显式 UTF-8** 读改写（PowerShell `Set-Content` 会破坏 UTF-8，勿用）；跳过 node_modules / target / 二进制。
- 替换后 `git commit-tree` 造无父根提交 → 推 GitHub `main` + `B<版本>` tag。
- 配置模板见根目录 `config.example.json`（占位符，可公开；真实值走 env/DPAPI/Keystore，不入库）。

## 二、已知泄露凭据（2026-08-15 全量审计定位，轮换责任在用户）

> 审计范围：全量历史 299 commits（排除 node_modules / 编译产物 / 二进制）。结论：**4 处真实泄露** + 1 个已红化占位符（假阳性）。

| # | 类型 | 掩码 | 位置（历史） | 处置 |
|---|------|------|--------------|------|
| 1 | DeepSeek API key | `sk-e636…7cc5` | `poc/scripts/configure-models.sh:8`（文件已删，历史仍留） | 用户 Revoke + 重发 |
| 2 | MiniMax API key | `sk-cp-v…mxNc` | `poc/scripts/configure-models.sh:9`（文件已删，历史仍留） | 用户 Revoke + 重发 |
| 3 | gca-server 生产 token（64 hex） | `deec68b9…73b336` | 6 个文件：`android/app/src/main/assets/gca-token.txt`、`android/fix-gateway-android.sh`、`archive/poc/docs/openclaw-ubuntu-setup.md`、`archive/poc/settings.json`、`desktop-rs/tests/term_flow.rs`、`desktop-rs/tests/term_full_flow.rs`（tree 已红化，历史仍留） | 用户 Revoke + 重发 |
| 4 | gitea 账号 token（40 hex） | `62d675…650d` | `.git/config` 的 `origin` URL（非 git 跟踪，本地明文） | 用户 Revoke |

> 完整值不入库。需复核时用 `git grep -F "<前缀>" $(git rev-list --all)` 或 `git log -S "<前缀>" --all` 在历史中查。

## 三、软件审查四维（本项目审查框架，每轮审查逐维过）

> 与 `docs/review-report-2026-08-12.md` 的四维一致：**安全 / 冲突 / 关联 / 功能符合度**。
> 每维下面「本仓先例」是实际踩过的坑，审查时按同类模式扫。

### 3.1 安全（Security）

**查什么**：鉴权绕过、注入、敏感信息泄露、拒绝服务（崩溃/无限增长）。

- **鉴权/授权**：设备 token 只存网关侧、不做设备=owner 坍缩（S1）；免审批/免确认路径是否有旁路（如 curl/wget `-o` 写盘、票据 URL 免确认的 host 校验）。
- **注入**：shell 命令注入（exec 分类器封死 shutdown/rundll32/重启等绕行）、路径注入（file 工具根目录护栏）、XSS（面板 esc/escJs 转义）、SSRF（reurl 白名单 + 拒回环私网）、SendKeys/特殊字符转义、service 环境传参。
- **凭据**：不得硬编码任何 key/token/密码；走 env / DPAPI credential-store / Android Keystore；写盘用原子写 + 最小权限（0600）。
- **DoS**：外部输入（HTTP body、文件、网络响应）必须有 try/catch + 上限 + 超时；表/缓存必须 sweep，不能无限增长。

### 3.2 冲突 / 并发（Conflict & Race）

**查什么**：并发读写、时序竞态、流串扰、锁隐患。

- **读-改-写竞态**（M7）：并发改同一状态文件/表 → 后写覆盖先写（丢更新）。解法见 §七。
- **流/会话串扰**：旧连接数据污染新会话（term_sse 缺 gen 过滤）、SSE 断开后残留 reader。
- **时序竞态**：resize/尺寸在连接前设置、连接后不补发；CPR 双应答；shell 初始化尺寸错 → 行号偏移。
- **锁/持锁**：长持锁（SESSIONS 300s）改短临界区或读写分离；死代码删掉（exec.rs run_user/session_*）。
- **共享资源**：共享 client 连接超时互相拖累（connect_timeout 8s→2s、probe 5s→3s）。

### 3.3 关联 / 集成（Correlation & Integration）

**查什么**：跨组件接口、状态一致性、端到端链路、协议/命名一致。

- **接口对齐**：agent/term/server/desktop 端口（+10 约定）、设备 MCP 代理与直连两种模式结果一致、token 模型三处一致（openclaw.json Authorization / 设备认证 / 代理转发）。
- **状态一致**：列表 vs 详情页（uptime 详情页不跳）、四态显示与 server 探测一致、DHCP 心跳更新设备 URL。
- **端到端**：注册→审批→设备恢复、代理 query 转义（`?`→%3F 曾致 404）、审计推送目标注入。
- **命名/协议**：camelCase 字段、紧凑 JSON、产物命名 `<包名>-<平台>-<V/B/D>X.Y.Z.<格式>`。

### 3.4 功能符合度（Functional Conformance）

**查什么**：规格实现完整、边界/上限、错误路径、平台一致。

- **规格完整**：20 工具与 node 版对齐、审批三通道（App 卡片/飞书卡片/按 id 端点）行为一致。
- **边界/上限**：file_read 三重上限（64MB/4000 行/512KB）、exec 输出 1MB、MCP body 1MB、截图/剪贴板往返一致。
- **错误路径**：畸形 body 不炸进程（readJson try/catch）、网络失败容错（飞书 unhandledRejection）。
- **平台一致**：Windows/POSIX/Android 分支行为一致（power/service 双实现、API 24/26 保护、高低版本分支）。

### 3.5 通用正确性清单（每轮都要过）

- **崩溃面**：所有外部输入（HTTP body、文件内容、命令输出、网络响应）都套 try/catch + 上限 + 超时；索引/切片/光标定位查 off-by-one（scroll_up 光标差一行曾丢行）。
- **资源**：超时（connect/read 30s）、断开清理（abort + reader.cancel + res error 处理）、临时文件/票据过期（一次性票据单次 404）。
- **编码**：exec 输出强制 UTF-8（`chcp 65001>nul &&`）；脚本编码 GBK+CRLF（UTF-8/LF 双击闪退）；转义正确性（escJs 双重转义防模板折叠）。
- **生命周期可逆**：副作用都有 disposer（定时器/订阅/监听）；托盘退出 = 全套退出（kill_local_services）；单实例保护。

## 四、已修复安全项（勿回退、勿重提为 P0）

- **S1 设备 token 隔离**：openclaw.json 只存设备自铸 deviceToken，不再写 owner token（`server/src/devices.ts`）。
- **M7 openclaw.json 读改写竞态（2026-08-15）**：`withConfigLock` 串行化 + 临界区重读 + 原子写（temp+rename）+ 写后刷新缓存（见 §七）。
- SSRF 白名单、面板 XSS 转义、MCP body 1MB 截断、ops 表 sweep、JSON.parse 崩溃 DoS、SSE 断开崩溃/泄漏、decodeURIComponent safeDecode、fetch 超时。
- 飞书网络失败容错、card-action 无 token fail-closed、审批限速 + loopback-only、opId 熵提升、审计补全。
- Android：凭据 Keystore/EncryptedSharedPreferences 加密、SSE 心跳、API 26 channel 保护、手势/通知修正。
- 详见 `docs/review-report-2026-08-12.md` 与 `docs/review-report-2026-08-14.md`。

## 五、记录在案未修（设计项/功能缺口，审查时标注即可，不作 P0）

- **M6 确认码带内返回**（设计问题）、**M11 开放模式无 token**（设计开关）。
- **A-M10 无障碍 touch exploration 与审批手势冲突**：⏳ 待真机开 TalkBack 实测。
- **功能缺口**：scrollback 不渲染、256 色映射/反色渲染、uptime 详情页不跳。

## 六、审查会话必跑清单

1. 读本文件 + `GCA-MASTER.md` + 两个 review-report（2026-08-12 / 2026-08-14）。
2. **软件审查**：按 §三 四维 + 通用清单逐项过；产出按「编号-问题-严重度-修复」落表（沿用 review-report 格式）。
3. **密钥扫描（全量历史）**——已覆盖模式（`git grep -I -E`，排除 node_modules / `*.map` / `*.cjs` / `*.min.js` / `*.min.css`）：
   - `sk-[a-z0-9_-]{20,}`（DeepSeek/OpenAI/Anthropic/MiniMax）
   - `ghp_` / `github_pat_` / `gh[ousr]_`（GitHub token）
   - `AKIA[0-9a-z]{16}`（AWS）、`xox[baprs]-…`（Slack）
   - `-----BEGIN …PRIVATE KEY-----`（私钥）
   - `Bearer [a-z0-9._-]{20,}`
   - `(api[_-]?key|secret|password|passwd|token|authorization)[[:space:]]*[:=][[:space:]]*["'][a-z0-9._/-]{16,}["']`
   - **盲区**：裸 40/64-hex token 与 git commit SHA 无法自动区分，只能人工对照已知凭据清单；另外二次解析时注意用 POSIX 引擎（git grep）而非 .NET（`.NET` 不支持 `[[:space:]]`）。
4. 新增代码不得写死任何凭据；凭据走环境变量 / `credential-store`（DPAPI）/ Android Keystore。
5. 复核 §一 双仓库红线，尤其「禁止直接 push 本地历史到 GitHub」。

### 产出格式（标准化）

**严重度定义**：

| 级别 | 含义 | 处置 |
|------|------|------|
| **H 高** | 安全漏洞 / 崩溃 DoS / 数据损坏 / 鉴权绕过 / 可致生产事故 | 必须修，提交前必清 |
| **M 中** | 功能缺陷 / 资源泄漏 / 一致性问题 / 体验问题 | 应修 |
| **L 低** | 代码质量 / 命名 / 小优化 / 潜在隐患 | 择机修 |
| **记录在案** | 设计决策 / 待实测 / 功能缺口（非缺陷） | 标注即可，不当 P0 |

**报告落表模板**（按模块分组；编号 = 级别 + 序号，Android 侧加 `A-` 前缀）：

| 编号 | 问题 | 严重度 | 修复 |
|------|------|--------|------|
| H1 | 问题一句话 + 根因 | 高 | 修复方式 / 提交号 |
| A-H1 | Android 侧问题 | 高 | … |

**报告结构**：
1. 基线（git sha）
2. 分模块问题表（server / agent / desktop-rs / android）
3. 记录在案（未修，附原因）
4. 验证（测试数 + 部署/实测状态）

## 七、M7 修复模式（后续类似并发读写参考）

- 单进程内 **promise 链互斥锁**（`withConfigLock`）+ 临界区内**重读最新文件** + **原子写**（写临时文件 + `rename`）+ 写成功后**刷新内存缓存**。
- 落点：`server/src/devices.ts`；原子写本身早已存在，M7 补的是「并发读-改-写互相覆盖（丢更新）」这一层。
- 教训：原子写（temp+rename）只能防半写/损坏，**不能防丢更新**；真正的竞态要锁 + 临界区重读。
