//! AI 聊天页：调 gca-server 的 chat_ai 工具（会话 main，与飞书/微信同步）。
//! 历史记录持久化到 %APPDATA%/GCA Desktop/chat-history.json。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: String, // "user" | "ai"
    pub text: String,
    pub ts: u64,
}

pub struct ChatState {
    pub messages: Vec<ChatMsg>,
    pub sending: bool,
    pub input: String,
    pub error: String,
}

impl Default for ChatState {
    fn default() -> Self {
        Self { messages: load_history(), sending: false, input: String::new(), error: String::new() }
    }
}

impl ChatState {
    pub fn send(&mut self, http: &crate::http::HttpClient, server_url: &str, token: &str) {
        let msg = self.input.trim().to_string();
        if msg.is_empty() || self.sending { return; }
        self.messages.push(ChatMsg { role: "user".into(), text: msg.clone(), ts: now_ms() });
        save_history(&self.messages);
        self.input.clear();
        self.sending = true;
        self.error.clear();
        let args = serde_json::json!({ "message": msg, "sessionKey": "main" });
        http.mcp_call("chat_ai", &format!("{server_url}/mcp"), token, "chat_ai", &args);
    }

    /// chat_ai 响应（body 为 JSON: {sessionKey, runId, text}）
    pub fn apply_reply(&mut self, body: &str) {
        self.sending = false;
        let text = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(String::from))
            .unwrap_or_else(|| "(无回复)".to_string());
        self.messages.push(ChatMsg { role: "ai".into(), text, ts: now_ms() });
        save_history(&self.messages);
    }

    pub fn apply_error(&mut self, err: &str) {
        self.sending = false;
        self.error = err.to_string();
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        let _ = std::fs::remove_file(history_path());
    }
}

fn history_path() -> PathBuf {
    std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("chat-history.json"))
        .unwrap_or_else(|_| PathBuf::from("chat-history.json"))
}

fn load_history() -> Vec<ChatMsg> {
    std::fs::read_to_string(history_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_history(msgs: &[ChatMsg]) {
    if let Some(parent) = history_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let last = msgs.iter().rev().take(200).cloned().collect::<Vec<_>>();
    let _ = std::fs::write(history_path(), serde_json::to_string(&last).unwrap_or_default());
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
