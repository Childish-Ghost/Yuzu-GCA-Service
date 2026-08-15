//! MCP server 分发（gca-agent bin 用）：initialize / tools/list / tools/call。
//! 22 工具 + 审批 + consent——AI 通道标准 MCP，无会话（AI 命令无状态）。

use crate::http;
use crate::tools;

/// Bearer 校验（长度 + 逐字节比较，常数时间）
pub fn authed(req: &http::Request, token: &str) -> bool {
    let Some(header) = req.header("Authorization") else { return false };
    let Some(presented) = header.strip_prefix("Bearer ") else { return false };
    let presented = presented.trim();
    if presented.len() != token.len() {
        return false;
    }
    presented.bytes().zip(token.bytes()).all(|(a, b)| a == b)
}

/// MCP JSON-RPC 分发（POST /mcp，Bearer 校验由路由层做）
pub fn handle(req: &http::Request) -> http::Response {
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(serde_json::Value::Null);

    match method {
        "initialize" => http::Response::json(
            200,
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "gca-agent", "version": "0.3.0" },
                }
            }),
        ),
        "tools/list" => {
            let tools: Vec<serde_json::Value> = tools::list()
                .into_iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.schema,
                    })
                })
                .collect();
            http::Response::json(
                200,
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "tools": tools }
                }),
            )
        }
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_default();
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
            match tools::call(name, &args) {
                Ok(outcome) => {
                    // blocked/error 状态标记 isError
                    let is_error = outcome.text.get("status").and_then(|s| s.as_str())
                        == Some("blocked")
                        || outcome.text.get("status").and_then(|s| s.as_str()) == Some("error")
                        || outcome.text.get("status").and_then(|s| s.as_str()) == Some("confirm_failed");
                    let mut content = serde_json::json!([
                        { "type": "text", "text": serde_json::to_string(&outcome.text).unwrap_or_default() }
                    ]);
                    // screenshot 附加 image content 块（base64 + mime）
                    if let Some((data, mime)) = outcome.image {
                        content
                            .as_array_mut()
                            .unwrap()
                            .push(serde_json::json!({ "type": "image", "data": data, "mimeType": mime }));
                    }
                    let mut result = serde_json::json!({ "content": content });
                    if is_error {
                        result["isError"] = serde_json::json!(true);
                    }
                    http::Response::json(
                        200,
                        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    )
                }
                Err(e) => http::Response::json(
                    200,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": e }
                    }),
                ),
            }
        }
        _ => http::Response::json(
            200,
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            }),
        ),
    }
}
