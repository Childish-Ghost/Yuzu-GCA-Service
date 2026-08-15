# 项目维护优化清单

> 从项目维护角度审视架构、流程和技术债务

| 类别 | 数量 |
|------|------|
| 已解决 | 3 |
| 必须做 | 3（2 项已有进展） |
| 强烈建议 | 3 |
| 锦上添花 | 1 |

## 已解决

::: tip API 数量精简
从最初 180+ API 精简到 36 个 MCP Tool（2026-07-23 新增 ui_tree 后共 37 个），用 exec 兜底低频操作。JSON Schema 自动校验。
:::

::: tip 测试策略落地（POC，2026-07-23）
POC 已建立测试基线：**56 个单元测试**（exec 分类器/三级审批/执行器/会话管理）+ **8 个 E2E 测试**（端到端链路），全部通过。后续每个 Tool 按同标准补齐测试。
:::

## 必须做

::: danger P0 — 跨平台 UI 自动化
AI 应用操控需要 Accessibility API：Windows (UIAutomation)、Linux (AT-SPI2)、macOS (AX API)。三套 API，每个平台独立实现。

**方案：** ① 定义 UIAdapter 接口，每平台一个实现；② Phase 1 只做 Windows；③ 优先用浏览器自动化（Playwright 跨平台一致）。
:::

::: danger P0 — 缺少测试策略 `部分解决`
36 MCP Tool × 多平台 × 多设备接入方式 = 测试矩阵。

**方案：** ① 单元测试：每个 tool handler 独立测试；② 集成测试：客户端 MCP Server ↔ Gateway；③ E2E 测试：Telegram → AI → MCP Tool → 执行；④ CI：GitHub Actions。

**进展（2026-07-23）：** ①③ 已在 POC 落地（56 单元 + 8 E2E 全过）；②④ 待 Phase 1/2。
:::

::: danger P0 — 无错误恢复策略 `Phase 1 排期`
网络断开、Gateway 重启、设备休眠。远程场景下错误是常态。

**方案：** ① WS 自动重连（指数退避）；② 请求超时 + 重试；③ 幂等性设计（idempotency key）。

**进展：** POC 验证了断网 60s 恢复边界用例（BT-03）；完整重连机制已排入 Phase 1 第 4 批。
:::

## 强烈建议

::: warning P1 — 无日志与可观测性
远程设备出问题时没有日志无法排查。

**方案：** ① 结构化日志（pino/winston）；② 日志通过 WS 上报到 Gateway 集中查看；③ 健康心跳（30s 上报 CPU/内存/磁盘）。
:::

::: warning P1 — 无配置管理方案
客户端需要配置（Gateway 地址、token、代理、服务开关）。

**方案：** ① 本地 JSON 配置 + 系统 keychain 存凭据；② Gateway 可远程推送配置；③ JSON Schema 校验。
:::

::: warning P1 — 无自动化构建发布
客户端要打包成 Windows .exe / Linux .deb / Android APK。手动打包耗时易错。

**方案：** ① GitHub Actions CI；② tag push 自动构建所有平台；③ 自动更新机制（Tauri updater / Expo OTA）。
:::

## 锦上添花

::: info P2 — 文档迁移 `已完成`
当前手写 HTML，改一个样式要改多处。迁移到 VitePress 可用 Markdown 写内容。

**进展（2026-07-23）：** 已完成迁移（Markdown + VitePress，本地搜索、统一主题），并经过两轮内容优化同步最新决策。
:::

::: info P2 — 性能监控仪表盘
多设备运行后需要统一视图查看所有设备健康状态。
:::
