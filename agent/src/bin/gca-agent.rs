//! gca-agent：AI 通道（被控设备）——标准 MCP server。
//! 22 工具 + 审批 + consent；无会话（AI 命令无状态）。
//! 端点：/health /mcp /transfer/{token}（规范见 docs/architecture.md）。
//! 服务逻辑在 lib `agent_server`（Android JNI 桥共用同一入口）。

use gca_agent::{agent_server, config};

fn main() {
    let cfg = config::load();
    if let Err(e) = agent_server::serve(&cfg) {
        eprintln!("HTTP server error: {e}");
        std::process::exit(1);
    }
}
