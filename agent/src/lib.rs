//! GCA 设备端公共库——工具实现 + MCP/终端服务分发。
//! 两个二进制共享（独立部署，任意组合）：
//!   gca-agent（AI 通道）：标准 MCP server /mcp（22 工具 + 审批 + consent）
//!   gca-term（人终端）：终端服务 /term/*（会话化 exec 免审批 + 目录/平台/审计）
//! 规范见 docs/architecture.md（命名/端口/端点约定）。
//!
//! 平台说明（Android 原生化，docs/android-native-plan.md）：
//!   conpty/term 为 Windows 真终端（ConPTY FFI），Android 只编 agent 部分——
//!   经 JNI 启动本 lib 的 MCP 服务（gca-agent bin 逻辑），term 不随 APK。

pub mod agent_server;
pub mod approval;
pub mod audit;
pub mod base64;
pub mod config;
#[cfg(target_os = "windows")]
pub mod conpty;
pub mod consent;
pub mod http;
#[cfg(target_os = "android")]
pub mod jni_bridge;
pub mod logging;
pub mod mcp;
pub mod pending;
pub mod ps;
#[cfg(target_os = "windows")]
pub mod term;
pub mod tickets;
pub mod tools;
