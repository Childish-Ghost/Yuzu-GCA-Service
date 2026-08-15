# Win7 适配计划（2026-08-11）

> 目标：让 Win7 电脑（无 Win10+ 机器可用时）能参与 GCA 体系
> 约束分析 → 可行性矩阵 → 实施路径

## 1. 硬约束（无法绕过的墙）

| 约束 | 影响 | 结论 |
|------|------|------|
| **ConPTY（CreatePseudoConsole）是 Win10 1809+ 专属** | gca-term 真终端在 Win7 无法创建伪终端（kernel32 无此 API；conpty.dll 依赖 Win10 组件） | ❌ **Win7 不能做"远程终端被控"** |
| **winit（egui 窗口后端）要求 Win10** | desktop-rs 控制端在 Win7 跑不起来 | ❌ **Win7 不能装桌面控制端** |
| **现代 Rust std 可能引入 Win10 API** | gca-agent 需旧版 Rust（~1.72）编译才有 Win7 兼容性 | ⚠️ 需实验验证 |

## 2. 可行性矩阵

| 角色 | Win7 可行性 | 方案 |
|------|------------|------|
| **控制端（远程终端/设备管理）** | ✅ 可行 | 浏览器访问 gca-server 面板 + 新增终端页（Win7 Chrome 49+ 支持 fetch/流式） |
| **被控（AI 通道 exec/文件/截图）** | ⚠️ 实验性 | 旧版 Rust（1.72）编译 gca-agent——导入表含 Win7 兼容 API（std TCP + powershell 子进程）——需实测 |
| **被控（人终端 ConPTY）** | ❌ 不可行 | ConPTY 硬墙——无替代 |

## 3. 实施路径（按优先级）

### 路径 A：控制端——浏览器终端（✅ 可行，优先做）
1. gca-server 控制面板（DASHBOARD_HTML）加「🖥 终端」tab
2. 终端渲染：JS 简化版 vte（光标定位/清屏/清行/SGR 颜色/滚动——够 cmd/PS 基本使用）
3. SSE：`fetch` 流式读取（能带 Bearer 头——EventSource 不能带自定义头）
4. 输入：键盘事件 → base64 POST（与 desktop 同链路：`/device/:name/term/input`）
5. resize/shell 切换：复用现有代理端点
6. 验证：Win7 Chrome 49 打开面板 → 登录 → 终端 → cmd/PS 操作

### 路径 B：被控 AI 通道——gca-agent（⚠️ 实验性，后做）
1. `rustup toolchain install 1.72`（Win7 支持的最后一个稳定版线）
2. 1.72 编译 `gca-agent`（release）
3. 检查导入表：无 CreatePseudoConsole 等 Win10 API（gca-agent 不引用 conpty——release 链接消除）
4. 拷到 Win7：`gca-agent.exe` + 配置（token/端口）→ 启动 → 注册到 gca-server
5. 验证：gca-server 设备列表出现 Win7 设备 → AI 调 exec/sysinfo 正常
6. 注意：Win7 的 PowerShell 5.1 工具兼容性（截图/剪贴板等需实测）

### 路径 C：被控真终端（❌ 不做）
- ConPTY 硬墙——除非 Win7 升级/重装 Win10——不做

## 4. 风险与备选

| 风险 | 备选 |
|------|------|
| gca-agent 在 Win7 有 API 兼容问题 | 放弃 B 路径——Win7 只做控制端 |
| Win7 Chrome 49 太旧（部分 JS 语法不支持） | 面板终端 JS 用 ES5 兼容写法（避免箭头函数/模板字符串等新语法） |
| Win7 无浏览器可用 | 装旧版 Chrome（49 是最后支持 Win7 的版本）或 Firefox ESR |

## 5. 决策记录

- 2026-08-11：确认 Win7 适配**先做路径 A（浏览器终端）**——明确可行、零安装、一次会话能完成
- 路径 B 视用户需求（Win7 机器是否真的需要被控）再启动
