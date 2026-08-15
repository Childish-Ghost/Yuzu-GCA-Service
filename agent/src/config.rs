//! 设备端配置：全部来自环境变量（与 node client 一致，token 不硬编码）。
//!   GCA_MCP_TOKEN  — MCP 端点 Bearer 配对 token（空 = 开放模式）
//!   GCA_MACHINE_ID — SMBIOS UUID（注册身份）
//!   GCA_AGENT_PORT  — 监听端口（默认 3001）

pub struct Config {
    pub port: u16,
    pub token: String,
    #[allow(dead_code)] // 注册功能接入后使用
    pub machine_id: String,
    pub device_name: String,
}

pub fn load() -> Config {
    Config {
        port: std::env::var("GCA_AGENT_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3001),
        token: std::env::var("GCA_MCP_TOKEN").unwrap_or_default(),
        machine_id: std::env::var("GCA_MACHINE_ID").unwrap_or_default(),
        device_name: std::env::var("GCA_DEVICE_NAME")
            .unwrap_or_else(|_| "gca-agent-rs".to_string()),
    }
}
