# MCP Tools 能力全景

> 客户端（MCP Server）暴露给 Gateway 的全部工具，AI 自动调用

::: warning 实施节奏（2026-07-23 决策）
37 个 Tool 是**目标全景**，不是一次性开发。按[修订后路线图](/roadmap)分批交付：

- **MVP（Phase 1，2 周）**：`exec` + `file_list` + `sysinfo` — 验证核心链路 ✅ exec 已在 POC 实现
- **Phase 2（4 周）**：扩展到 10 个核心 Tool
- **Phase 3+**：其余按实际使用反馈排期
:::

| 类别 | 数量 | 首批交付 |
|------|------|----------|
| 设备管理 | 4 | Phase 3 |
| 命令执行 | 3 | **exec → MVP** ✅ |
| 文件操作 | 6 | **file_list → MVP**；read/write/move → Phase 2 |
| 系统控制 | 3 | **sysinfo → MVP** |
| 远程桌面 | 4 | Phase 3+ |
| AI 操控 | 6 | Phase 4+（ui_tree 优先） |
| 网络管理 | 3 | Phase 3+ |
| 硬件监控 | 3 | Phase 3+ |
| 开发者工具 | 3 | Phase 2（log_read） |
| 媒体通信 | 2 | notify_send → Phase 2 |

## 设备管理（4 tools）

| Tool | 说明 | 参数 |
|------|------|------|
| `device_list` | 列出所有已注册设备及在线状态 | 无参数 |
| `device_info` | 获取指定设备的详细信息（OS、IP、资源使用） | `device: string` |
| `device_add` | 添加新设备配置（客户端自动注册，此 Tool 用于手动注册 CLI 设备） | `id, name, url: string` |
| `device_remove` | 移除设备配置 | `device: string` |

## 命令执行（3 tools）

| Tool | 说明 | 参数 | 阶段 |
|------|------|------|------|
| `exec` | 在指定设备上执行命令并等待结果（**三级审批**：只读免审/写操作确认/危险拦截） | `device: string, command: string, timeout?: number` | **MVP** ✅ POC 已实现 |
| `exec_background` | 后台执行长时间命令，返回任务 ID | `device: string, command: string` | Phase 2 |
| `process_list` | 列出指定设备上的进程（支持按 CPU/内存排序） | `device: string, sort?: "cpu" \| "memory", limit?: number` | Phase 2 |

## 文件操作（6 tools）

| Tool | 说明 | 参数 | 阶段 |
|------|------|------|------|
| `file_list` | 列出目录内容（支持 glob 过滤和递归） | `device: string, path: string, pattern?: string, recursive?: boolean` | **MVP** |
| `file_read` | 读取文件内容（支持行范围读取） | `device: string, path: string, offset?: number, limit?: number` | Phase 2 |
| `file_write` | 写入/创建文件 | `device: string, path: string, content: string` | Phase 2 |
| `file_move` | 移动/重命名文件 | `device: string, from: string, to: string` | Phase 2 |
| `file_delete` | 删除文件 | `device: string, path: string` | Phase 2 |
| `file_transfer` | 跨设备文件传输（控制平面走 Gateway + 数据平面直连） | `from_device: string, from_path: string, to_device: string, to_path: string` | Phase 3 |

## 系统控制（3 tools）

| Tool | 说明 | 参数 | 阶段 |
|------|------|------|------|
| `sysinfo` | 获取系统信息（CPU/内存/磁盘/网络/运行时间） | `device: string` | **MVP** |
| `power` | 电源操作（关机/重启/休眠/Wake-on-LAN） | `device: string, action: "shutdown" \| "restart" \| "hibernate" \| "wol"` | Phase 2 |
| `service` | 系统服务管理（启动/停止/重启/查看状态） | `device: string, name: string, action: "start" \| "stop" \| "restart" \| "status"` | Phase 2 |

## 远程桌面 — 人工操控（4 tools）`Phase 3+`

> 架构：控制平面走 Gateway（认证 + 签发 token + 审计），数据平面直连（推流 + 键鼠）。详见[系统流程](/flow#_3-人工远程控制流程)。

| Tool | 说明 | 参数 |
|------|------|------|
| `screenshot` | 截取远程设备屏幕画面（**WebP 压缩 ~30KB，Token 消耗较 base64 JPEG 降 4 倍**） | `device: string, display?: number, quality?: number` |
| `remote_input` | 发送鼠标/键盘事件到远程设备 | `device: string, type: "mouse_move" \| "mouse_click" \| "mouse_scroll" \| "key_type" \| "key_press" \| "hotkey", ...` |
| `remote_stream` | 开始/停止屏幕推流（Gateway 签发 token，返回数据平面直连地址） | `device: string, action: "start" \| "stop", fps?: number, quality?: number` |
| `clipboard_sync` | 读取/设置远程设备剪贴板，跨设备同步 | `device: string, action: "get" \| "set" \| "sync", content?: string` |

## AI 应用操控（6 tools）`Phase 4+`

> 成本优化：**`ui_tree` 优先于截图**——本地 Accessibility API 提取结构化 UI 元素树，零 API 成本；覆盖不了的场景才回退 screen_capture + 视觉模型。详见 [AI 模型策略](/ai-strategy)。

| Tool | 说明 | 参数 |
|------|------|------|
| `ui_tree` | 本地提取应用 UI 元素树（结构化 JSON，零 API 成本，优先于视觉方案） | `device: string, app: string` |
| `ui_find` | 通过 Accessibility API 查找应用内的 UI 元素 | `device: string, app: string, element: string, role?: string` |
| `ui_act` | 操作 UI 元素（点击/输入/选择/读取） | `device: string, element_id: string, action: "click" \| "set_value" \| "get_value"` |
| `browser_open` | 在远程设备上打开 URL 或操控已打开的浏览器 | `device: string, url?: string, attach?: boolean` |
| `browser_act` | 浏览器内操作（填写表单/点击元素/截图/获取文本） | `device: string, action: "fill" \| "click" \| "screenshot" \| "get_text", selector?: string, value?: string` |
| `ocr_screen` | 对远程设备屏幕进行 OCR 文字识别（a11y 树覆盖不了时的兜底） | `device: string, region?: { x, y, width, height }` |

## 网络管理（3 tools）

| Tool | 说明 | 参数 |
|------|------|------|
| `net_status` | 网络状态（接口/IP/连通性/流量） | `device: string` |
| `net_wifi` | WiFi 管理（扫描/连接/列出已保存网络） | `device: string, action: "scan" \| "connect" \| "list", ssid?: string, password?: string` |
| `net_ping` | 网络诊断（ping/traceroute/DNS 查询） | `device: string, target: string, action?: "ping" \| "traceroute" \| "dns"` |

## 硬件监控（3 tools）

| Tool | 说明 | 参数 |
|------|------|------|
| `hw_temps` | 温度监控（CPU/GPU/磁盘温度） | `device: string` |
| `hw_battery` | 电池状态（电量/充电状态/健康度） | `device: string` |
| `hw_disk` | 磁盘信息（分区/使用量/SMART 数据） | `device: string` |

## 开发者工具（3 tools）

| Tool | 说明 | 参数 |
|------|------|------|
| `docker_ps` | Docker 容器管理（列表/启动/停止/重启/日志） | `device: string, action: "list" \| "start" \| "stop" \| "restart" \| "logs", container?: string` |
| `git_op` | Git 操作（status/pull/push/log） | `device: string, repo: string, action: "status" \| "pull" \| "push" \| "log"` |
| `log_read` | 读取系统/应用日志 | `device: string, source: string, lines?: number, filter?: string` |

## 媒体通信（2 tools）

| Tool | 说明 | 参数 |
|------|------|------|
| `media_control` | 媒体播放控制（播放/暂停/下一曲/音量） | `device: string, action: "play" \| "pause" \| "next" \| "prev" \| "volume", value?: number` |
| `notify_send` | 发送桌面通知到指定设备 | `device: string, title: string, body?: string` |
