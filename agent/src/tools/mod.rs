//! 工具注册表：名称/描述/输入 schema + 分发。
//! 返回值为 MCP content 里的 JSON 对象（mcp.rs 包装成 content 格式）。

pub mod clipboard_sync;
pub mod confirm;
pub mod consent_tools;
pub mod exec;
pub mod exec_background;
pub mod file_ops;
pub mod file_transfer;
pub mod notify_send;
pub mod power;
pub mod process_list;
pub mod remote_input;
pub mod screenshot;
pub mod service;
pub mod sysinfo;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: serde_json::Value,
}

/// 工具调用结果：text 为 MCP content 文本块 JSON；image 可选
/// （screenshot：base64 + mime，包装成 {type:"image",...} content 块）
pub struct CallOutcome {
    pub text: serde_json::Value,
    pub image: Option<(String, String)>,
}

impl From<serde_json::Value> for CallOutcome {
    fn from(v: serde_json::Value) -> Self {
        Self { text: v, image: None }
    }
}

pub fn list() -> Vec<ToolDef> {
    vec![
        sysinfo::def(),
        exec::def(),
        confirm::def(),
        process_list::def(),
        file_ops::def_list(),
        file_ops::def_read(),
        file_ops::def_write(),
        file_ops::def_move(),
        file_ops::def_delete(),
        power::def(),
        service::def(),
        exec_background::def(),
        screenshot::def(),
        remote_input::def(),
        clipboard_sync::def(),
        notify_send::def(),
        consent_tools::def_screen(),
        consent_tools::def_input(),
        file_transfer::def_serve(),
        file_transfer::def_fetch(),
    ]
}

/// 分发工具调用，返回 MCP content（可能含 image 块）
pub fn call(name: &str, args: &serde_json::Value) -> Result<CallOutcome, String> {
    Ok(match name {
        "sysinfo" => sysinfo::run()?.into(),
        "exec" => exec::run(args)?.into(),
        "confirm" => confirm::run(args)?,
        "process_list" => process_list::run(args)?.into(),
        "file_list" => file_ops::run_list(args)?.into(),
        "file_read" => file_ops::run_read(args)?.into(),
        "file_write" => file_ops::run_write(args)?.into(),
        "file_move" => file_ops::run_move(args)?.into(),
        "file_delete" => file_ops::run_delete(args)?.into(),
        "power" => power::run(args)?.into(),
        "service" => service::run(args)?.into(),
        "exec_background" => exec_background::run(args)?.into(),
        "screenshot" => screenshot::run(args)?,
        "remote_input" => remote_input::run(args)?.into(),
        "clipboard_sync" => clipboard_sync::run(args)?.into(),
        "notify_send" => notify_send::run(args)?.into(),
        "screen_consent" => consent_tools::run_screen(args)?.into(),
        "input_consent" => consent_tools::run_input(args)?.into(),
        "file_serve" => file_transfer::run_serve(args)?.into(),
        "file_fetch" => file_transfer::run_fetch(args)?.into(),
        _ => return Err(format!("Unknown tool: {name}")),
    })
}
