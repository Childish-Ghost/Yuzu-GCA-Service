//! 登录页：服务器地址 + 密钥，验证 health + devices 后进入主界面。
//! 凭据持久化到 %APPDATA%/GCA Desktop/config.json（不硬编码）。
//!
//! S1（2026-08-12 审查）：config.json 增加 device_token——设备自铸 token，
//! 与 owner 管理 token 隔离（此前配对拿到 owner token，设备=owner 授权坍缩）。
//! C16 最小修复：写入后收紧 ACL（icacls 继承隔离 + 当前用户 FULL）；
//! 完整方案（DPAPI/wincred 加密存储）记入审查报告遗留节。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Default)]
pub struct LoginState {
    pub url: String,
    pub token: String,
    pub error: String,
    pub busy: bool,
    pub done: bool,
    /// 嗅探结果（局域网 gca-server 地址列表）
    pub scan_results: Vec<String>,
    pub scanning: bool,
    /// 本机部署组件（None=检测中；Some(vec)=agent/term 子集；空=纯控制端）
    pub local_components: Option<Vec<String>>,
    /// 本机设备注册状态："unknown"|"unregistered"|"pending"|"registered"|"error"
    pub reg_status: String,
    /// 注册请求确认码（pending 时显示，owner 在飞书/微信或服务器页批准）
    pub reg_code: String,
    /// 注册审批 op id（轮询 GET /ops/:id 用）
    pub reg_op_id: String,
    pub reg_note: String,
    pub reg_busy: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct ConfigFile {
    token: String,
    server_url: String,
    #[serde(default)]
    device_token: String,
}

pub fn config_path() -> PathBuf {
    std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("config.json"))
        .unwrap_or_else(|_| PathBuf::from("config.json"))
}

pub fn load_saved() -> Option<(String, String)> {
    let cfg = load_config();
    if cfg.token.is_empty() || cfg.server_url.is_empty() {
        None
    } else {
        Some((cfg.server_url, cfg.token))
    }
}

/// 设备自铸 token（S1）：已存在则复用；否则铸造（零依赖熵源：
/// 纳秒 + PID + 单调计数 FNV 混合 → 64 hex）并持久化。
pub fn ensure_device_token() -> Option<String> {
    let mut cfg = load_config();
    if !cfg.device_token.is_empty() {
        return Some(cfg.device_token);
    }
    let token = generate_device_token();
    cfg.device_token = token.clone();
    persist(&cfg);
    Some(token)
}

fn load_config() -> ConfigFile {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn persist(cfg: &ConfigFile) {
    if let Some(parent) = config_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(config_path(), serde_json::to_string_pretty(cfg).unwrap_or_default());
    tighten_acl(&config_path());
}

/// C16 最小修复：config.json 写入后收紧 ACL——继承隔离 + 当前用户 FULL
/// （此前默认继承父目录权限，其他用户可能可读 token）。失败静默（尽力而为；
/// 完整方案 DPAPI/wincred 记入遗留）。
fn tighten_acl(path: &PathBuf) {
    #[cfg(target_os = "windows")]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        if user.is_empty() {
            return;
        }
        let _ = std::process::Command::new("cmd.exe")
            .args(["/c", &format!("icacls \"{}\" /inheritance:r /grant:r \"{}:F\"", path.display(), user)])
            .output();
    }
}

fn generate_device_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut h = 0xcbf29ce484222325u64
        ^ nanos.rotate_left(17)
        ^ (std::process::id() as u64).wrapping_mul(0x9e3779b97f4a7c15)
        ^ counter.wrapping_mul(0x9e3779b97f4a7c15);
    let mut out = String::with_capacity(64);
    for _ in 0..64 {
        h = h.wrapping_mul(0x100000001b3) ^ (h >> 33);
        out.push("0123456789abcdef".as_bytes()[(h & 0xf) as usize] as char);
    }
    out
}

/// 保存登录凭据（合并已有配置——不覆盖 device_token）
pub fn save(url: &str, token: &str) {
    let mut cfg = load_config();
    cfg.token = token.to_string();
    cfg.server_url = url.to_string();
    persist(&cfg);
}
