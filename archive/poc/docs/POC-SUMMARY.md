# GCA POC 执行方案 — 汇总

> 2026-07-27 更新：POC 已通过验证，进入 Phase 1 自用期。Android APK 已交付。

---

## 一、当前架构

```
┌─────────────────────────────────────────────────────┐
│  AI 模型 (DeepSeek / GPT-4o)                         │
│  via Feishu/WeChat/Telegram                          │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│  OpenClaw Gateway (Ubuntu VM <网关IP>)              │
│  MCP Streamable HTTP Client                          │
│  Bearer token 认证                                    │
└──────┬──────────────┬──────────────┬────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Windows  │  │  Linux   │  │   Android    │
│ :3001    │  │  :3002   │  │   :3003      │
│ 20 tools │  │ 20 tools │  │ 13 tools (7  │
│ 全功能   │  │ 全功能   │  │ 个 isAndroid │
│          │  │          │  │ 守卫返回     │
│          │  │          │  │ unsupported) │
└──────────┘  └──────────┘  └──────────────┘
```

## 二、设备支持矩阵

| 平台 | 端口 | 架构 | 可用 tool | 状态 |
|------|------|------|-----------|------|
| Windows x64 | 3001 | Node.js 22 | 20/20 | ✅ 生产 |
| Linux x64 | 3002 | Node.js 22 | 20/20 | ✅ 生产 |
| Android arm64 | 3003 | libnode.so (v18.20.4) | 13/20 | ✅ 已交付 |

### Android 可用 tool (13)
`sysinfo` `exec` `confirm` `file_list` `file_read` `file_write` `file_move` `file_delete` `file_serve` `file_fetch` `exec_background` `process_list` `clipboard_sync`

### Android 守卫 tool (7 — 返回 unsupported)
`power` `service` `notify_send` `screenshot` `screen_consent` `remote_input` `input_consent`

原因：这些 tool 需要 Java/Kotlin 系统级 API（DevicePolicyManager、MediaProjection、AccessibilityService 等），嵌入式 Node.js 无法直接调用。后续可通过 Kotlin ↔ JNI 回调桥接。

## 三、Android 技术栈

```
APK
├── libnode.so (nodejs-mobile v18.20.4)
├── libgca-native.so (JNI 桥)
│   └── gca-native.cpp → node::Start(argc, argv)
├── GcaService.kt (前台 Service)
│   ├── BOOT_COMPLETED 自启
│   ├── synchronized 防双启 (SIGTRAP 崩溃)
│   ├── HOME → app filesDir (clipboard EACCES fix)
│   └── --token → GCA_MCP_TOKEN env
├── gca-bundle.cjs (57K 行，esbuild 打包)
│   └── poc/src → TypeScript → tsc → esbuild → CJS
└── MCP Streamable HTTP at /mcp
```

## 四、20 Tools 完整列表

| # | Tool | 类型 | 审批 | Android |
|---|------|------|------|---------|
| 1 | `sysinfo` | 只读 | 免审 | ✅ |
| 2 | `exec` | 命令执行 | 三级审批 | ✅ |
| 3 | `confirm` | 审批确认 | 免审 | ✅ |
| 4 | `file_list` | 只读 | 免审 | ✅ |
| 5 | `file_read` | 只读 | 免审 | ✅ |
| 6 | `file_write` | 写操作 | 确认 | ✅ |
| 7 | `file_move` | 写操作 | 确认 | ✅ |
| 8 | `file_delete` | 写操作 | 确认 | ✅ |
| 9 | `file_serve` | 跨设备传输 | 确认 | ✅ |
| 10 | `file_fetch` | 跨设备传输 | ticket免审 | ✅ |
| 11 | `exec_background` | 后台命令 | 三级审批 | ✅ |
| 12 | `process_list` | 只读 | 免审 | ✅ |
| 13 | `clipboard_sync` | 写操作 | 确认 | ✅ |
| 14 | `notify_send` | 通知 | 免审 | ❌ 守卫 |
| 15 | `screenshot` | 隐私 | 许可窗 | ❌ 守卫 |
| 16 | `screen_consent` | 许可窗管理 | 确认 | ❌ 守卫 |
| 17 | `remote_input` | 键鼠控制 | 许可窗 | ❌ 守卫 |
| 18 | `input_consent` | 许可窗管理 | 确认 | ❌ 守卫 |
| 19 | `power` | 系统电源 | OTP | ❌ 守卫 |
| 20 | `service` | 服务管理 | OTP | ❌ 守卫 |

### 审批模型
- **免审 (auto-approved)**：只读操作，直接执行
- **确认 (confirmation_required)**：写操作，返回 confirmToken，用户确认后调 confirm 执行
- **OTP**：高危操作，验证码弹出到设备屏幕/Push到手机/Authenticator，AI 永远看不到验证码
- **拦截 (blocked)**：危险命令（rm -rf /、format 等），直接拒绝

## 五、传输协议

- **主协议**：MCP Streamable HTTP (spec 2025-03-26+) at `/mcp`
- **遗留协议**：SSE at `/sse` + `/messages`（Phase 1 过渡期保留）
- **健康检查**：`GET /health`（无需认证）
- **认证**：`Authorization: Bearer <token>`（配对令牌）
- **配对**：`gca pair` CLI → 生成 token → 写入 Gateway 配置

## 六、Gateway 配置示例

```json
{
  "mcpServers": {
    "home-pc": {
      "url": "http://<本机IP>:3001/mcp",
      "transport": "streamable-http"
    },
    "gca-android": {
      "url": "http://<Android设备IP>:3003/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer deec68b9..."
      }
    }
  }
}
```

## 七、已完成的集成项

| 编号 | 项目 | 状态 |
|------|------|------|
| INT-001 | 配对握手协议 (gca pair) | ✅ |
| INT-002 | gca-client npm 打包 | ✅ |
| INT-003 | gca-server 控制面 (设备清单/吊销/审计) | ✅ |
| R-003 | clipboard sync 跨设备 | ✅ |
| R-001 | screenshot + screen_consent | ✅ |
| R-002 | remote_input + input_consent | ✅ |
| R-004 | 按需截屏 (非推流) | ✅ |
| P-004 | Android APK (nodejs-mobile) | ✅ |

## 八、待完成

| 编号 | 项目 | 优先级 |
|------|------|--------|
| | Gateway 配 Android URL (/health → /mcp) | 🔴 立即 |
| INT-004 | mDNS 服务发现 | 🟡 |
| INT-005 | Audit push 集成到 tools | 🟡 |
| | Phase 4: Tauri 桌面客户端 | 🟢 |
| | Android 7 个守卫 tool 的 Kotlin 桥接 | 🟢 |