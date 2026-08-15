//! 待确认操作队列：写操作（exec/file_*/power/service/background）经用户确认后执行。
//! D4 对齐（2026-08-12 审查：与 node 版同一协议，此前 rust 忽略 token 直接 pop_latest）：
//!   - push 铸 6 位 confirmToken（32 字母表，与 node pending-approvals.ts 一致）
//!   - consume(token)：精确消费、single-use、过期判断（任意 kind，含 Power）
//!   - pop_latest()：裸确认取最近操作，但**排除 Power**（与 node consumeLatestOfKinds 一致）
//!   - MAX_PENDING=100：超限队首驱逐（与 node 一致）
//! TTL 300s。

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub enum PendingOp {
    Exec { command: String, cwd: Option<String>, timeout_ms: Option<u64> },
    FileWrite { path: String, content: String, mode: String, create_dirs: bool },
    FileMove { source: String, dest: String },
    FileDelete { path: String, recursive: bool },
    Power { action: String },
    Service { action: String, name: String },
    Background { command: String, cwd: Option<String> },
    // --- 隐私工具（与 node 版对齐）---
    Screenshot { quality: u8, ocr: bool },
    RemoteInput { action: String, x: Option<i32>, y: Option<i32>, button: String, delta: i32, text: String },
    ClipboardSync { action: String, text: String },
    InputConsent { minutes: u32 },
    ScreenConsent { minutes: u32 },
    FileServe { path: String },
    FileFetch { url: String, target_path: String },
}

const TTL_SECS: u64 = 300;
const MAX_PENDING: usize = 100;

/// 与 node 版相同的无歧义字母表（无 0/O、1/I/L——人读/人输的 token）
const TOKEN_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const TOKEN_LEN: usize = 6;

static QUEUE: Mutex<VecDeque<(u64, String, PendingOp)>> = Mutex::new(VecDeque::new());

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// 零依赖 token 铸造：SystemTime 纳秒 + 进程内单调计数，FNV-1a 混合。
/// 本地确认凭据（非网络凭证），此熵足够；票据 token 见 tickets.rs（另有降级方案）。
fn mint_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut h = 0xcbf29ce484222325u64 ^ nanos.rotate_left(17) ^ counter.wrapping_mul(0x9e3779b97f4a7c15);
    let mut out = String::with_capacity(TOKEN_LEN);
    for _ in 0..TOKEN_LEN {
        h = h.wrapping_mul(0x100000001b3) ^ (h >> 33);
        out.push(TOKEN_ALPHABET[(h % TOKEN_ALPHABET.len() as u64) as usize] as char);
    }
    out
}

fn audit_granted(op: &PendingOp) {
    // 审计：审批通过（INT-005，detail 含操作内容）
    crate::audit::push("approval_granted", &format!("{op:?}"), "ok");
}

/// 入队并返回 confirmToken（调用方把它放进 confirmation_required 响应，
/// 与 node 版协议一致——AI 凭 token 精确确认对应操作）
pub fn push(op: PendingOp) -> String {
    let now = now_secs();
    let token = mint_token();
    let mut q = QUEUE.lock().unwrap();
    // 队首清理过期
    while let Some(front) = q.front() {
        if now.saturating_sub(front.0) > TTL_SECS {
            q.pop_front();
        } else {
            break;
        }
    }
    // MAX_PENDING：超限队首驱逐最旧（C7 对齐 node）
    while q.len() >= MAX_PENDING {
        q.pop_front();
    }
    q.push_back((now, token.clone(), op));
    token
}

/// 精确消费：按 token 匹配（single-use）+ 过期判断。任意 kind 均可（含 Power）。
/// 过期/未知/已消费 → None（token 已作废，不可重试）。
pub fn consume(token: &str) -> Option<PendingOp> {
    let now = now_secs();
    let mut q = QUEUE.lock().unwrap();
    let idx = q.iter().position(|(_, t, _)| t == token)?;
    let (ts, _, op) = q.remove(idx)?;
    if now.saturating_sub(ts) > TTL_SECS {
        return None;
    }
    audit_granted(&op);
    Some(op)
}

/// 裸确认：取最近一个未过期操作（从队尾往前扫）。
/// **排除 Power**（与 node consumeLatestOfKinds 的 kinds 列表一致——
/// power 关机/重启等必须带 token 精确确认）。被跳过的条目**不删除**，
/// 仍可凭 token 精确消费（与 node 语义一致）。
pub fn pop_latest() -> Option<PendingOp> {
    let now = now_secs();
    let mut q = QUEUE.lock().unwrap();
    let mut pick: Option<usize> = None;
    for i in (0..q.len()).rev() {
        let (ts, _, op) = &q[i];
        if now.saturating_sub(*ts) > TTL_SECS {
            continue;
        }
        if matches!(op, PendingOp::Power { .. }) {
            continue; // Power 必须带 token
        }
        pick = Some(i);
        break;
    }
    if let Some(i) = pick {
        let (_, _, op) = q.remove(i).unwrap();
        audit_granted(&op);
        return Some(op);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试串行锁：QUEUE 是全局单例，cargo test 并行跑会互相干扰
    /// （queue_evicts 断言长度时被其他测试 push/pop 打乱——2026-08-13 修）
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 清空队列（测试用）
    fn clear() {
        QUEUE.lock().unwrap().clear();
    }

    #[test]
    fn pop_latest_returns_most_recent_first() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        push(PendingOp::Power { action: "sleep".into() });
        push(PendingOp::Exec { command: "ipconfig".into(), cwd: None, timeout_ms: None });
        push(PendingOp::FileWrite {
            path: "C:\\x.txt".into(),
            content: "hi".into(),
            mode: "overwrite".into(),
            create_dirs: false,
        });
        // LIFO：最近推入的先确认
        assert!(matches!(pop_latest(), Some(PendingOp::FileWrite { .. })));
        assert!(matches!(pop_latest(), Some(PendingOp::Exec { .. })));
        assert!(pop_latest().is_none());
    }

    #[test]
    fn pop_empty_queue_returns_none() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        assert!(pop_latest().is_none());
    }

    #[test]
    fn bare_confirm_excludes_power() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        let p_tok = push(PendingOp::Power { action: "shutdown".into() });
        push(PendingOp::Exec { command: "dir".into(), cwd: None, timeout_ms: None });
        // 裸确认跳过 Power 取最近非 power
        assert!(matches!(pop_latest(), Some(PendingOp::Exec { .. })));
        // Power 未被删除——仍可凭 token 精确消费
        assert!(matches!(consume(&p_tok), Some(PendingOp::Power { .. })));
        assert!(pop_latest().is_none());
    }

    #[test]
    fn consume_matches_exact_token_single_use() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        let t1 = push(PendingOp::Exec { command: "whoami".into(), cwd: None, timeout_ms: None });
        let t2 = push(PendingOp::FileWrite {
            path: "C:\\y.txt".into(),
            content: "x".into(),
            mode: "overwrite".into(),
            create_dirs: false,
        });
        assert_ne!(t1, t2);
        // 精确消费 t1（先入队的）
        assert!(matches!(consume(&t1), Some(PendingOp::Exec { .. })));
        // 已消费 → None（single-use）
        assert!(consume(&t1).is_none());
        // 错误 token → None
        assert!(consume("ZZZZZZ").is_none());
        // t2 仍在
        assert!(matches!(consume(&t2), Some(PendingOp::FileWrite { .. })));
    }

    #[test]
    fn consume_accepts_power() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        let t = push(PendingOp::Power { action: "restart".into() });
        assert!(matches!(consume(&t), Some(PendingOp::Power { .. })));
    }

    #[test]
    fn queue_evicts_oldest_at_capacity() {
        let _g = TEST_LOCK.lock().unwrap();
        clear();
        for i in 0..(MAX_PENDING + 20) {
            push(PendingOp::Exec { command: format!("cmd{i}"), cwd: None, timeout_ms: None });
        }
        // 队列容量保持 MAX_PENDING
        assert_eq!(QUEUE.lock().unwrap().len(), MAX_PENDING);
        // 最旧的 20 条被驱逐：队首是最新（容量内最早的是 i=20）
        let front_cmd = match &QUEUE.lock().unwrap().front().unwrap().2 {
            PendingOp::Exec { command, .. } => command.clone(),
            _ => String::new(),
        };
        assert_eq!(front_cmd, "cmd20");
    }

    #[test]
    fn minted_tokens_are_well_formed() {
        let _g = TEST_LOCK.lock().unwrap();
        let seen: Vec<String> = (0..50).map(|_| mint_token()).collect();
        for t in &seen {
            assert_eq!(t.len(), TOKEN_LEN);
            assert!(t.chars().all(|c| TOKEN_ALPHABET.contains(&(c as u8))));
        }
        // 碰撞概率极低；但至少不能全相同
        assert!(seen.iter().collect::<std::collections::HashSet<_>>().len() > 1);
    }
}
