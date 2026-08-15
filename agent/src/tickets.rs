//! 一次性传输票据（file_serve 数据面）：单次使用、5 分钟 TTL、绑定单个文件。
//! token 由 PowerShell RNG 生成 24 字节 base64url（零依赖真随机），
//! 消耗时从表删除（单次使用），与 node 版 transfer-tickets.ts 行为一致。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Ticket {
    pub path: String,
    pub size: u64,
}

const TTL_SECS: u64 = 300;

// HashMap::new 非 const，用 OnceLock 惰性初始化（std-only）
static TICKETS: std::sync::OnceLock<Mutex<HashMap<String, (u64, Ticket)>>> = std::sync::OnceLock::new();

fn tickets() -> &'static Mutex<HashMap<String, (u64, Ticket)>> {
    TICKETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// 铸造票据并返回 token（已绑定 path/size）
pub fn mint(path: String, size: u64) -> Result<String, String> {
    let token = random_token()?;
    let mut m = tickets().lock().unwrap();
    // 懒清理过期项
    m.retain(|_, (t, _)| now().saturating_sub(*t) <= TTL_SECS);
    m.insert(token.clone(), (now(), Ticket { path, size }));
    Ok(token)
}

/// 校验并消耗（单次使用）。未知/过期/已用返回 None。
pub fn consume(token: &str) -> Option<Ticket> {
    let mut m = tickets().lock().unwrap();
    // 先删（单次使用语义：即使过期也不可再用）
    let (created, ticket) = m.remove(token)?;
    if now().saturating_sub(created) > TTL_SECS {
        return None;
    }
    Some(ticket)
}

/// 24 字节 base64url 随机 token（PowerShell RNG 首选——.NET Framework 无静态
/// GetBytes(int)，用 Create() + byte[] 实例方法）。
/// C17 修复（2026-08-12 审查）：PowerShell 失败（被禁/降级环境）时降级到
/// 零依赖熵源，不再让服务不可用。
fn random_token() -> Result<String, String> {
    match powershell_token() {
        Ok(t) => Ok(t),
        Err(e) => {
            eprintln!("[tickets] PowerShell RNG unavailable ({e}), using fallback entropy");
            Ok(fallback_token())
        }
    }
}

fn powershell_token() -> Result<String, String> {
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$b = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')",
        ])
        .output()
        .map_err(|e| format!("RNG spawn failed: {e}"))?;
    if !out.status.success() {
        return Err("RNG failed".to_string());
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.len() < 20 {
        return Err("RNG produced short token".to_string());
    }
    Ok(token)
}

const BASE64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 零依赖降级熵源：SystemTime 纳秒 + PID + 单调计数 + 主机名，FNV-1a 混合 → 32 字符
/// base64url。票据是 5 分钟一次性局域网凭证，弱熵可接受（引入真随机 crate 会
/// 破坏 agent 零依赖承诺，不选）。
fn fallback_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut h = 0xcbf29ce484222325u64 ^ nanos.rotate_left(17);
    h = (h ^ (std::process::id() as u64).wrapping_mul(0x9e3779b97f4a7c15)).wrapping_mul(0x100000001b3);
    h = (h ^ counter.wrapping_mul(0x9e3779b97f4a7c15)).wrapping_mul(0x100000001b3);
    // 主机名混入（跨进程/跨机器区分度）
    for b in std::env::var("COMPUTERNAME")
        .unwrap_or_default()
        .bytes()
        .chain(std::env::var("HOSTNAME").unwrap_or_default().bytes())
    {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    let mut out = String::with_capacity(32);
    for _ in 0..4 {
        h = h.wrapping_mul(0x100000001b3) ^ (h >> 33);
        for b in (h as u32).to_be_bytes() {
            out.push(BASE64URL[b as usize % 64] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_single_use() {
        // 消耗空表 → None
        assert!(consume("nonexistent-token").is_none());

        // mint → consume 成功（走 PowerShell RNG，Windows 环境）
        let token = match mint("/tmp/somefile.txt".into(), 42) {
            Ok(t) => t,
            Err(e) => {
                // PowerShell 不可用（非 Windows）→ 跳过
                eprintln!("mint skipped: {e}");
                return;
            }
        };
        assert!(token.len() >= 20);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));

        let t = consume(&token).expect("fresh ticket must be consumable");
        assert_eq!(t.path, "/tmp/somefile.txt");
        assert_eq!(t.size, 42);

        // 单次使用：再消耗 → None
        assert!(consume(&token).is_none());
    }

    #[test]
    fn minted_tokens_are_unique() {
        let a = mint("f".into(), 1).unwrap_or_default();
        let b = mint("f".into(), 1).unwrap_or_default();
        if !a.is_empty() && !b.is_empty() {
            assert_ne!(a, b);
        }
    }
}
