//! 日志：内存环形缓冲（UI 展示）+ 落盘（%APPDATA%\GCA Desktop\logs\desktop.log）——
//! 所有操作（登录/设备/终端连接/输入/错误）可追溯。
//! 滚动：单文件超 2MB → 移入 logs\archive\（时间戳命名）→ 异步 GZip 压缩
//! （PowerShell GZipStream，系统自带零依赖）→ 删除原文件。

#[derive(Debug, Clone)]
pub enum LogKind {
    Info,
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub ts: String,
    pub msg: String,
    pub kind: LogKind,
}

/// 日志目录
fn log_dir() -> std::path::PathBuf {
    std::env::var("APPDATA")
        .map(|d| std::path::PathBuf::from(d).join("GCA Desktop").join("logs"))
        .unwrap_or_else(|_| std::path::PathBuf::from("logs"))
}

/// 写一条日志到 desktop.log（滚动 + 归档）
fn write_file_log(line: &str) {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("desktop.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
    // 滚动检查（写入后大小超限）
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            rollover(&path, "desktop");
        }
    }
}

/// 滚动：当前文件 → archive\name-<ts>.log → 异步 gzip → 删除原
fn rollover(path: &std::path::PathBuf, name: &str) {
    let _ = std::fs::create_dir_all(log_dir().join("archive"));
    let ts = chrono_like_now_full().replace([':', '-'], "");
    let archived = log_dir().join("archive").join(format!("{name}-{ts}.log"));
    if std::fs::rename(path, &archived).is_ok() {
        let archived2 = archived.clone();
        std::thread::spawn(move || {
            let script = format!(
                "$i=[IO.File]::ReadAllBytes('{p}');$o=[IO.File]::Create('{p}.gz');$g=New-Object IO.Compression.GzipStream($o,[IO.Compression.CompressionMode]::Compress);$g.Write($i,0,$i.Length);$g.Close();$o.Close();Remove-Item '{p}'",
                p = archived2.display()
            );
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                    .creation_flags(0x08000000)
                    .output();
            }
        });
    }
}

/// 首次使用：迁移旧日志（根目录 *.log）到 logs\archive\
pub fn migrate_old_logs() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let root = std::path::PathBuf::from(appdata).join("GCA Desktop");
        let archive = log_dir().join("archive");
        let _ = std::fs::create_dir_all(&archive);
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let p = e.path();
                let is_log = p.extension().map(|x| x == "log").unwrap_or(false);
                let is_root = p.parent().map(|d| d == root.as_path()).unwrap_or(false);
                if is_log && is_root {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let _ = std::fs::rename(&p, archive.join(name));
                }
            }
        }
    }
}

#[derive(Default)]
pub struct Logs {
    entries: std::collections::VecDeque<LogEntry>,
}

impl Logs {
    pub fn add(&mut self, msg: impl Into<String>, kind: LogKind) {
        let ts = chrono_like_now();
        let msg = msg.into();
        self.entries.push_back(LogEntry { ts: ts.clone(), msg: msg.clone(), kind: kind.clone() });
        while self.entries.len() > 500 {
            self.entries.pop_front();
        }
        // 落盘（所有操作可追溯）
        let level = match kind {
            LogKind::Info => "INFO",
            LogKind::Ok => "OK",
            LogKind::Warn => "WARN",
            LogKind::Error => "ERROR",
        };
        let line = format!("{ts} | {level} | {msg}\n");
        write_file_log(&line);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn iter(&self) -> impl Iterator<Item = &LogEntry> {
        self.entries.iter()
    }
}

/// 独立落盘日志（不占 UI 环形缓冲）——给非 UI 上下文（如 ensure_term）用
pub fn file_log(level: &str, msg: &str) {
    let ts = chrono_like_now();
    let line = format!("{ts} | {level} | {msg}\n");
    write_file_log(&line);
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}")
}

/// 完整时间戳（归档文件名用）
fn chrono_like_now_full() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth0 = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth0 > 12 { y + 1 } else { y };
    let mth = if mth0 > 12 { mth0 - 12 } else { mth0 };
    format!("{y:04}-{mth:02}-{d:02}-{h:02}{m:02}{s:02}")
}
