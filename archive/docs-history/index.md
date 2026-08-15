---
layout: home

hero:
  name: "Global Control Assistant"
  text: "跨设备远程控制与 AI 自动化系统"
  tagline: 任意设备控制任意设备 · AI 对话操作所有设备
  image: null
  actions:
    - theme: brand
      text: 系统架构
      link: /architecture
    - theme: alt
      text: 能力全景
      link: /capabilities

features:
  - title: 任意 → 任意
    details: 手机找电脑文件、电脑查服务器日志、微信开关游戏服务器。发起方可以是任意设备或任意聊天通道。
    icon: 🔀
  - title: 客户端接入
    details: 所有被控设备装自建客户端（MCP Server + UI）。Gateway 统一调度所有客户端。
    icon: 🔌
  - title: AI 对话控制
    details: 通过微信/飞书/Telegram 用自然语言控制设备。AI 自动选择正确的设备和命令。
    icon: 💬
  - title: 自建客户端
    details: Android APK + Desktop (Tauri) + CLI。AI 对话 + 设备管理 + 远程桌面 UI。
    icon: 🖥️
  - title: 远程桌面
    details: 客户端截取本机屏幕，通过 WS 数据端口推流到请求方。鼠标键盘事件实时转发。
    icon: 🖱️
  - title: 外网访问
    details: 聊天通道（微信/飞书）不需要穿透 NAT。客户端直连用 Tailscale 或 DDNS-GO。
    icon: 🌍
  - title: 跨通道记忆
    details: identityLinks 统一身份，MEMORY.md 跨通道持久记忆。微信说的事飞书也知道。
    icon: 🧠
  - title: 双轨更新
    details: 小更新 JS bundle OTA 静默推送（新增页面/修 Bug），大更新 APK 重装（原生模块变更）。
    icon: 🔄
---

## 这个项目是什么？

**Global Control Assistant (GCA)** 是一个**跨设备远程控制与 AI 自动化系统**。

**核心思路：** 1 台主机运行 OpenClaw Gateway（MCP Host，AI 大脑）。每台被控设备装一个**自建客户端**，客户端作为 MCP Server 暴露本机能力给 Gateway。不装客户端的设备不纳入控制范围。

**使用方式：** 通过任意通道（微信、飞书、Telegram、自建客户端）用自然语言告诉 AI 你要做什么——"看看服务器磁盘满了没"、"把手机照片传到电脑"、"重启游戏服务器"。AI 自动选择正确的设备和 MCP Tool 执行。

**自建客户端**有两个功能：① 与 Gateway 沟通（聊天/远程桌面 UI）；② 暴露本机能力（MCP Server，让 AI 能操作这台设备）。

## 当前进度

::: tip Phase 0 — POC 技术验证（代码已完成，待 VM 联调）
- **POC 代码（`poc/`）**：Node.js 22 + MCP SDK 1.29 + Express SSE，exec Tool + 三级审批 ✅
- **测试**：56 单元测试 + 8 E2E 测试，全部通过 ✅
- **下一步**：Ubuntu VM 部署 OpenClaw Gateway + 飞书 Bot 联调（部署指南见仓库 `poc/docs/openclaw-ubuntu-setup.md`）

实施遵循[修订后路线图](/roadmap)：Phase 1 只做 3 个 Tool（exec + file_list + sysinfo）+ Node.js CLI + 飞书通道，2 周出 MVP。
:::

| 文档 | 内容 |
|------|------|
| [系统架构](/architecture) | 整体架构、客户端设计、连接流程、技术方案 |
| [能力全景](/capabilities) | 37 个 MCP Tools 定义与分批交付计划 |
| [实施路线图](/roadmap) | 修订后渐进路线（Phase 0 → 3，12 周拿到可用产品） |
| [AI 模型策略](/ai-strategy) | DeepSeek V4-Flash + 视觉模型双方案路由 |
| [可行性分析](/feasibility) | 技术风险评估、8 项决策记录、矛盾修复 |
| [安全分析](/security) | 风险分级与三级审批机制 |
| [系统流程](/flow) | 9 个核心流程完整走查 |
| [开发代办](/backlog) | 56 个任务按新路线图分批 |
