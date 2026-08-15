# AI 模型策略

> 双方案并存，按场景自动路由：命令行走纯文本模型（零视觉成本），GUI 操控走多模态模型

| 指标 | 数值 |
|------|------|
| 主力推理模型 | DeepSeek V4-Flash |
| 视觉模型（方案 A） | MiMo-V2.5 |
| 备选多模态（方案 B） | MiniMax-M3 |
| 路由原则 | 命令行 → A，GUI 操控 → B |

::: danger 时效警告：DeepSeek 旧 API 2026-07-24 停用
旧版 `deepseek-chat` / `deepseek-reasoner` API 于 **2026-07-24 停止服务**。

所有配置必须切换到 **`deepseek-v4-pro` / `deepseek-v4-flash`**，否则 Gateway 的 AI 能力会中断。
:::

## 策略总览

::: tip 核心思路：不把所有请求都塞给最贵的模型
GCA 的 AI 调用分两类，成本结构完全不同：

1. **命令行操控（90% 场景）**：用户说"看看磁盘满了没" → AI 选 Tool、填参数、格式化结果。**纯文本推理，不需要视觉**。
2. **GUI 操控（10% 场景）**：用户说"帮我打开 Chrome 搜天气" → AI 需要看屏幕、理解 UI、决定点哪里。**必须有多模态视觉**。

用同一个多模态大模型处理所有请求 = 为 10% 的场景付 100% 的视觉成本。因此采用双方案路由。
:::

```
用户消息
  │
  ▼
┌─────────────────┐
│  意图路由判断    │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
命令行操控   GUI 操控
（90%）     （10%）
    │         │
    ▼         ▼
┌────────┐ ┌────────────┐
│ 方案 A  │ │  方案 B     │
│DeepSeek│ │ MiniMax-M3 │
│V4-Flash│ │ 多模态单模型 │
│+MiMo   │ │            │
│-V2.5   │ │            │
└────────┘ └────────────┘
```

## 方案 A：DeepSeek V4-Flash + MiMo-V2.5（主力）

### 分工

| 角色 | 模型 | 职责 | 成本 |
|------|------|------|------|
| 大脑 | DeepSeek V4-Flash | 意图理解、Tool 选择、参数填充、结果格式化 | 极低（纯文本 API） |
| 眼睛 | MiMo-V2.5 | 屏幕截图理解、UI 元素定位、OCR 辅助 | $1 / $3 per M tokens |

### 为什么这样搭

- **DeepSeek V4-Flash**：推理能力强、原生支持工具调用（function calling）、价格极低。命令行场景的所有决策都是纯文本推理，Flash 完全够用，不需要 Pro。
- **MiMo-V2.5**：全模态模型，MIT 开源，视觉理解能力强。只在需要"看屏幕"时调用，按量付费。

### 协作流程（GUI 场景）

```
用户: "帮我点一下记事本的保存按钮"
  │
  ▼
DeepSeek V4-Flash（大脑）
  │  ① 判断需要视觉 → 调用 screen_capture
  ▼
客户端截屏（WebP ~30KB）
  │
  ▼
MiMo-V2.5（眼睛）
  │  ② 分析截图 → 返回"保存按钮在 (x, y)"
  ▼
DeepSeek V4-Flash（大脑）
  │  ③ 决策 → 调用 remote_input(mouse_click, x, y)
  ▼
客户端执行点击
```

## 方案 B：MiniMax-M3 多模态单模型（备选）

| 维度 | 说明 |
|------|------|
| 模型 | MiniMax-M3（OpenClaw 原生支持） |
| 成本 | $0.30 / $1.20 per M tokens |
| 优势 | 单模型处理文本+视觉，无需双模型编排，延迟低一跳 |
| 劣势 | 纯文本场景也要付多模态溢价；生态不如 DeepSeek |

**适用场景：** GUI 操控频率升高后（如远程桌面 AI 托管成为日常），单模型的低延迟和简单链路更有价值。

## 路由规则

| 场景 | 走哪个方案 | 原因 |
|------|-----------|------|
| exec / file_list / sysinfo 等命令行 Tool | A（DeepSeek 单模型） | 纯文本推理，零视觉成本 |
| 设备管理 / 日志查看 / 文件传输 | A（DeepSeek 单模型） | 结构化数据，不需要看图 |
| screenshot 理解 / UI 元素定位 | A（DeepSeek + MiMo） | 偶尔看一次，按量付费划算 |
| 高频 GUI 自动化（浏览器操控等） | B（MiniMax-M3） | 每步都要看图，单模型链路短 |

## 关键优化：降低视觉 Token 成本

::: tip screen_capture：WebP 替代 base64 JPEG
旧的 `screenshot` Tool 返回 base64 JPEG，单张约 **400KB**，交给视觉模型处理 Token 消耗巨大。

优化后：客户端本地转 **WebP 格式，单张约 30KB**，Token 消耗降低约 **4 倍**，视觉理解质量基本无损。
:::

::: tip ui_tree：本地提取结构化 UI，零 API 成本
很多 GUI 场景其实不需要"看图"。客户端通过 **Accessibility API** 在本地提取当前窗口的 UI 元素树（按钮、输入框、文本），以结构化 JSON 返回：

```
ui_tree("home-pc", app="notepad")
→ { "window": "无标题 - 记事本", "elements": [
    { "role": "button", "name": "保存", "rect": [x,y,w,h] },
    { "role": "edit", "name": "文本编辑器", "rect": [...] }
  ] }
```

DeepSeek 直接读这份 JSON 决策，**完全不需要视觉模型**，零 API 成本。只有 ui_tree 覆盖不了的场景（图形界面无 a11y 树）才回退到 screen_capture + 视觉模型。
:::

### 决策优先级

```
GUI 操控请求
  │
  ▼
① ui_tree 能拿到结构化元素？
  │  能 → DeepSeek 直接决策（零视觉成本）
  │  不能 ↓
  ▼
② screen_capture (WebP) + MiMo-V2.5 / MiniMax-M3
  │  视觉模型定位 → 大脑决策
  ▼
执行 remote_input
```

## 未来演进：V4.1 全模态

DeepSeek V4.1 规划支持全模态（文本 + 图像 + 音频）。API 开放后：

- 方案 A 可简化为 **DeepSeek 单模型**（大脑和眼睛合一），去掉双模型编排
- MiMo-V2.5 退为备用 / 本地兜底
- 路由规则不变，只是方案 A 内部实现简化

## 模型配置参考

```json
// ~/.openclaw/openclaw.json — agent 段
{
  "agent": {
    "model": "deepseek/deepseek-v4-flash",
    "fallbacks": ["deepseek/deepseek-v4-pro"],
    "vision": {
      "provider": "mimo",
      "model": "mimo-v2.5"
    },
    "multimodal": {
      "provider": "minimax",
      "model": "minimax-m3"
    }
  }
}
```

| 配置项 | 作用 |
|--------|------|
| `agent.model` | 主力推理模型（命令行场景唯一调用） |
| `agent.fallbacks` | 主力不可用时降级（Flash → Pro） |
| `agent.vision` | 方案 A 的"眼睛"，仅 screen_capture 场景调用 |
| `agent.multimodal` | 方案 B 单模型，高频 GUI 场景使用 |

::: warning 成本控制原则
1. 默认全部走 DeepSeek V4-Flash（纯文本）
2. ui_tree 优先于 screen_capture（结构化 JSON 零视觉成本）
3. screen_capture 必须 WebP 压缩（Token 降 4 倍）
4. 视觉模型只在"非看不可"时调用
5. 定期审计 Token 消耗，GUI 场景占比超 30% 再评估切方案 B
:::
