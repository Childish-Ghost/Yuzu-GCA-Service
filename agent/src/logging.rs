//! 统一日志系统（gca-term）：所有操作 + 连接事件。
//! 目录：%APPDATA%\GCA Desktop\logs\（集中管理，不再散落根目录）
//! 滚动：单文件超 MAX_LOG_BYTES → 移入 logs\archive\（时间戳命名）→
//!       异步 GZip 压缩（PowerShell GZipStream，系统自带零依赖）→ 删除原文件。
//! 迁移：首次使用把旧的根目录日志移入 logs\archive\。
//!
//! 格式：`时间 | 类别 | 消息`
//! 类别：session / conn / input / output / switch / reclaim / error

use std::io::Write;
use std::path::PathBuf;

/// 单日志文件滚动上限（2MB）
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// 日志目录（%APPDATA%\GCA Desktop\logs\）
pub fn log_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("logs"))
        .unwrap_or_else(|_| PathBuf::from("logs"))
}

/// 写一条日志（自动滚动 + 归档）
pub fn log(category: &str, msg: &str) {
    let line = format!("{} | {category} | {msg}\n", iso_now());
    // Android：无 %APPDATA% 文件日志，走 logcat（Android 原生化 P1）
    #[cfg(target_os = "android")]
    {
        crate::jni_bridge::logcat_info(line.trim_end());
        return;
    }
    eprintln!("{}", line.trim_end());
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("gca-term.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
    // 滚动检查（写入后大小超限）
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            rollover(&path, "gca-term");
        }
    }
}

/// 滚动：当前文件 → archive\name-<ts>.log → 异步 gzip → 删除原（pub 供审计用）
pub fn rollover_public(path: &PathBuf, name: &str) {
    rollover(path, name);
}

/// 滚动：当前文件 → archive\name-<ts>.log → 异步 gzip → 删除原
fn rollover(path: &PathBuf, name: &str) {
    let _ = std::fs::create_dir_all(log_dir().join("archive"));
    let ts = iso_now().replace([':', '-'], "");
    let archived = log_dir().join("archive").join(format!("{name}-{ts}.log"));
    if std::fs::rename(path, &archived).is_ok() {
        let archived2 = archived.clone();
        std::thread::spawn(move || {
            gzip_file(&archived2);
        });
    }
}

/// GZip 压缩（PowerShell GZipStream——系统自带，零依赖）
fn gzip_file(path: &PathBuf) {
    let script = format!(
        "$i=[IO.File]::ReadAllBytes('{p}');$o=[IO.File]::Create('{p}.gz');$g=New-Object IO.Compression.GzipStream($o,[IO.Compression.CompressionMode]::Compress);$g.Write($i,0,$i.Length);$g.Close();$o.Close();Remove-Item '{p}'",
        p = path.display()
    );
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
}

/// 首次使用：迁移旧日志（根目录 *.log）到 logs\archive\（不再散落）
pub fn migrate_old_logs() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let root = PathBuf::from(appdata).join("GCA Desktop");
        let archive = log_dir().join("archive");
        let _ = std::fs::create_dir_all(&archive);
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let p = e.path();
                let is_log = p.extension().map(|x| x == "log").unwrap_or(false);
                let is_root = p.parent().map(|d| d == root.as_path()).unwrap_or(false);
                if is_log && is_root {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let dest = archive.join(name);
                    let _ = std::fs::rename(&p, &dest);
                }
            }
        }
    }
}

/// 时间戳（YYYY-MM-DD HH:MM:SS，UTC——与 term-audit.log 一致）
fn iso_now() -> String {
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
    format!("{y:04}-{mth:02}-{d:02} {h:02}:{m:02}:{s:02}Z")
}
