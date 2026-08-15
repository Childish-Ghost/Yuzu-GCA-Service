//! 同意窗口状态（screen_consent / input_consent）：
//! 授予后截图/远程输入在窗口期内免逐个确认。内存态——agent 重启即撤销
//! （与 node 版持久化到 settings 相比更保守、更安全的方向，无需状态文件）。
//! 语义与 node 一致：revoke（minutes=0）即时生效；grant 需经 confirm 流程。

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq)]
pub enum ConsentKind {
    Screen,
    Input,
}

struct ConsentState {
    screen_until: Option<SystemTime>,
    input_until: Option<SystemTime>,
}

static CONSENT: Mutex<ConsentState> = Mutex::new(ConsentState { screen_until: None, input_until: None });

fn slot(state: &mut ConsentState, kind: ConsentKind) -> &mut Option<SystemTime> {
    match kind {
        ConsentKind::Screen => &mut state.screen_until,
        ConsentKind::Input => &mut state.input_until,
    }
}

/// 授予同意窗口，返回 ISO 到期时间（UTC）
pub fn grant(kind: ConsentKind, minutes: u32) -> String {
    let until = SystemTime::now() + Duration::from_secs(minutes as u64 * 60);
    let mut s = CONSENT.lock().unwrap();
    *slot(&mut s, kind) = Some(until);
    iso_from_unix(until.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
}

pub fn revoke(kind: ConsentKind) {
    let mut s = CONSENT.lock().unwrap();
    *slot(&mut s, kind) = None;
}

pub fn active(kind: ConsentKind) -> bool {
    let s = CONSENT.lock().unwrap();
    match slot_mut_ref(&s, kind) {
        Some(until) => *until > SystemTime::now(),
        None => false,
    }
}

/// 状态：{active, until}（until 仅在 active 时有值，ISO UTC）
pub fn status(kind: ConsentKind) -> (bool, Option<String>) {
    let s = CONSENT.lock().unwrap();
    match slot_mut_ref(&s, kind) {
        Some(until) if *until > SystemTime::now() => {
            let iso = iso_from_unix(until.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
            (true, Some(iso))
        }
        _ => (false, None),
    }
}

fn slot_mut_ref(s: &ConsentState, kind: ConsentKind) -> &Option<SystemTime> {
    match kind {
        ConsentKind::Screen => &s.screen_until,
        ConsentKind::Input => &s.input_until,
    }
}

/// Unix 秒 → ISO 8601 UTC（Howard Hinnant civil_from_days，零依赖）
fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_seconds_to_iso() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(946684800), "2000-01-01T00:00:00Z");
        // 2026-08-05 10:00:00 UTC
        assert_eq!(iso_from_unix(1785924000), "2026-08-05T10:00:00Z");
        // 闰年边界 2024-02-29
        assert_eq!(iso_from_unix(1709164800), "2024-02-29T00:00:00Z");
        // 秒内进位
        assert_eq!(iso_from_unix(59), "1970-01-01T00:00:59Z");
        assert_eq!(iso_from_unix(86400), "1970-01-02T00:00:00Z");
    }

    #[test]
    fn consent_window_lifecycle() {
        revoke(ConsentKind::Screen);
        assert!(!active(ConsentKind::Screen));
        let until = grant(ConsentKind::Screen, 10);
        assert!(active(ConsentKind::Screen));
        let (act, until_again) = status(ConsentKind::Screen);
        assert!(act);
        assert_eq!(until_again.as_deref(), Some(until.as_str()));
        // 不同 kind 互不影响
        assert!(!active(ConsentKind::Input));
        revoke(ConsentKind::Screen);
        assert!(!active(ConsentKind::Screen));
    }
}
