//! 文件工具：file_list / file_read（只读）+ file_write / file_move / file_delete（需确认）。
//! 零依赖：std::fs。写操作经 pending 队列，confirm 后执行。

use std::fs;
use std::path::{Path, PathBuf};

use crate::pending::{self, PendingOp};

const LIST_LIMIT: usize = 1000;

pub fn def_list() -> super::ToolDef {
    super::ToolDef {
        name: "file_list",
        description: "List files in a directory. Optional glob pattern, recursive.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path" },
                "pattern": { "type": "string", "description": "Filename glob pattern, e.g. *.txt" },
                "recursive": { "type": "boolean", "description": "Recurse subdirectories" }
            },
            "required": ["path"]
        }),
    }
}

pub fn def_read() -> super::ToolDef {
    super::ToolDef {
        name: "file_read",
        description: "Read a text file, optionally a line range (1-indexed).",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "startLine": { "type": "number" },
                "endLine": { "type": "number" }
            },
            "required": ["path"]
        }),
    }
}

pub fn def_write() -> super::ToolDef {
    super::ToolDef {
        name: "file_write",
        description: "Write or append text to a file. Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "content": { "type": "string" },
                "mode": { "type": "string", "enum": ["overwrite", "append"], "default": "overwrite" },
                "createDirs": { "type": "boolean", "description": "Create parent directories" }
            },
            "required": ["path", "content"]
        }),
    }
}

pub fn def_move() -> super::ToolDef {
    super::ToolDef {
        name: "file_move",
        description: "Rename or move a file/directory. Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "source": { "type": "string" },
                "dest": { "type": "string" }
            },
            "required": ["source", "dest"]
        }),
    }
}

pub fn def_delete() -> super::ToolDef {
    super::ToolDef {
        name: "file_delete",
        description: "Delete a file or directory. Never deletes filesystem roots. Requires confirmation.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "recursive": { "type": "boolean", "description": "Delete directory recursively" }
            },
            "required": ["path"]
        }),
    }
}

/// 文件系统根判断（拒绝删除根目录）
fn is_root(path: &Path) -> bool {
    let s = path.to_string_lossy().to_string();
    if s.is_empty() {
        return false;
    }
    // Windows: "C:\" / "C:" 或 "\"；Unix: "/"
    if path.parent().is_none() || path == path.parent().unwrap() {
        return true;
    }
    (s.len() <= 3 && s.ends_with(':')) || s == "\\" || s == "/"
}

/// glob 匹配（* 通配，忽略大小写）。语义：首段须从开头匹配，末段须匹配到
/// 名字末尾——除非模式以 * 结尾（尾部 * 吸收剩余任意内容）。
fn glob_match(pattern: &str, name: &str) -> bool {
    if pattern.is_empty() {
        return true;
    }
    let p = pattern.to_lowercase();
    let n = name.to_lowercase();
    if p == "*" {
        return true;
    }
    let anchored_end = !p.ends_with('*');
    let parts: Vec<&str> = p.split('*').collect();
    let mut rest = n.as_str();
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let is_last_part = parts[i + 1..].iter().all(|q| q.is_empty());
        let Some(pos) = rest.find(part) else { return false };
        if i == 0 && pos != 0 {
            return false; // 首段必须从开头匹配
        }
        if is_last_part && anchored_end && pos + part.len() != rest.len() {
            return false; // 末段必须匹配到末尾（模式不以 * 结尾时）
        }
        rest = &rest[pos + part.len()..];
    }
    true
}

fn entry_json(_dir: &Path, entry: &fs::DirEntry) -> Option<serde_json::Value> {
    let name = entry.file_name().to_string_lossy().to_string();
    let path = entry.path();
    let file_type = entry.file_type().ok()?;
    let (kind, size, mtime): (&str, Option<u64>, Option<String>) = if file_type.is_dir() {
        ("directory", None, None)
    } else if file_type.is_file() {
        let meta = entry.metadata().ok();
        (
            "file",
            meta.as_ref().and_then(|m| m.len().try_into().ok()),
            meta.and_then(|m| m.modified().ok()).map(|t| {
                let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                format!("{:?}", d.as_secs())
            }),
        )
    } else {
        ("other", None, None)
    };
    Some(serde_json::json!({
        "name": name,
        "path": path.to_string_lossy(),
        "type": kind,
        "size": size,
        "mtime": mtime,
    }))
}

fn list_dir(path: &Path, pattern: &str, recursive: bool, out: &mut Vec<serde_json::Value>, truncated: &mut bool) {
    if out.len() >= LIST_LIMIT {
        *truncated = true;
        return;
    }
    let Ok(entries) = fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        if out.len() >= LIST_LIMIT {
            *truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if glob_match(pattern, &name) {
            if let Some(j) = entry_json(path, &entry) {
                out.push(j);
            }
        }
        if recursive && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            list_dir(&entry.path(), pattern, true, out, truncated);
        }
    }
}

pub fn run_list(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "path required".to_string())?;
    let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
    let recursive = args.get("recursive").and_then(|r| r.as_bool()).unwrap_or(false);

    let mut entries = Vec::new();
    let mut truncated = false;
    list_dir(Path::new(path), pattern, recursive, &mut entries, &mut truncated);

    Ok(serde_json::json!({
        "status": "ok",
        "path": path,
        "pattern": if pattern.is_empty() { serde_json::Value::Null } else { serde_json::json!(pattern) },
        "recursive": recursive,
        "truncated": truncated,
        "totalEntries": entries.len(),
        "entries": entries,
    }))
}

pub fn run_read(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "path required".to_string())?;
    let start_line = args.get("startLine").and_then(|l| l.as_u64()).unwrap_or(1).max(1) as usize;
    let end_line = args.get("endLine").and_then(|l| l.as_u64());

    // F4 修复（2026-08-12 审查）：字节上限 1MB——此前整文件读入内存，
    // type huge.log 可 OOM；超限截断并置 truncated（与 exec 输出截断语义一致）
    const MAX_READ_BYTES: usize = 1024 * 1024;
    let raw = fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let truncated = raw.len() > MAX_READ_BYTES;
    let text = String::from_utf8_lossy(&raw[..raw.len().min(MAX_READ_BYTES)]).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    // startLine/endLine 均钳制到合法范围——start>end 或越界返回空内容，
    // 不 panic（远端可传 startLine=10,endLine=3 触发 slice 越界，2026-08-11 审查）
    let end = end_line.map(|e| e as usize).unwrap_or(total).min(total);
    let start = start_line.min(total);
    let content = if start == 0 || start > end {
        String::new()
    } else {
        lines[start - 1..end].join("\n")
    };

    Ok(serde_json::json!({
        "status": "ok",
        "path": path,
        "totalLines": total,
        "startLine": start_line,
        "endLine": end,
        "truncated": truncated,
        "content": content,
    }))
}

pub fn run_write(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "path required".to_string())?
        .to_string();
    let content = args.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let mode = args.get("mode").and_then(|m| m.as_str()).unwrap_or("overwrite").to_string();
    let create_dirs = args.get("createDirs").and_then(|c| c.as_bool()).unwrap_or(false);

    let token = pending::push(PendingOp::FileWrite { path: path.clone(), content, mode: mode.clone(), create_dirs });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "path": path,
        "reason": "file_write modifies state",
        "executed": false,
        "expiresInSec": 300,
    }))
}

pub fn run_move(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let source = args
        .get("source")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "source required".to_string())?
        .to_string();
    let dest = args
        .get("dest")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "dest required".to_string())?
        .to_string();

    let token = pending::push(PendingOp::FileMove { source: source.clone(), dest: dest.clone() });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "source": source,
        "dest": dest,
        "executed": false,
        "expiresInSec": 300,
    }))
}

pub fn run_delete(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "path required".to_string())?
        .to_string();
    let recursive = args.get("recursive").and_then(|r| r.as_bool()).unwrap_or(false);

    // 安全护栏：绝不删除文件系统根（即使确认后）
    if is_root(Path::new(&path)) {
        return Ok(serde_json::json!({
            "status": "error",
            "path": path,
            "error": "Refusing to delete a filesystem root",
        }));
    }

    let token = pending::push(PendingOp::FileDelete { path: path.clone(), recursive });
    Ok(serde_json::json!({
        "status": "confirmation_required",
        "token": token,
        "path": path,
        "executed": false,
        "expiresInSec": 300,
    }))
}

/// confirm 后的实际执行
pub fn run_confirmed(op: &PendingOp) -> serde_json::Value {
    match op {
        PendingOp::FileWrite { path, content, mode, create_dirs } => {
            let result = (|| -> Result<(), String> {
                if *create_dirs {
                    if let Some(parent) = Path::new(path).parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                }
                match mode.as_str() {
                    "append" => {
                        let mut f = fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
                        use std::io::Write;
                        f.write_all(content.as_bytes()).map_err(|e| e.to_string())
                    }
                    _ => fs::write(path, content).map_err(|e| e.to_string()),
                }
            })();
            match result {
                Ok(()) => serde_json::json!({
                    "status": "written",
                    "path": path,
                    "bytes": content.len(),
                    "mode": mode,
                    "confirmedByUser": true,
                }),
                Err(e) => serde_json::json!({ "status": "error", "path": path, "error": e }),
            }
        }
        PendingOp::FileMove { source, dest } => {
            match fs::rename(source, dest) {
                Ok(()) => serde_json::json!({
                    "status": "moved",
                    "source": source,
                    "dest": dest,
                    "confirmedByUser": true,
                }),
                Err(e) => serde_json::json!({ "status": "error", "source": source, "dest": dest, "error": e.to_string() }),
            }
        }
        PendingOp::FileDelete { path, recursive } => {
            let result = if *recursive {
                fs::remove_dir_all(path).map_err(|e| e.to_string())
            } else {
                let p = PathBuf::from(path);
                if p.is_dir() {
                    fs::remove_dir(&p).map_err(|e| e.to_string())
                } else {
                    fs::remove_file(&p).map_err(|e| e.to_string())
                }
            };
            match result {
                Ok(()) => serde_json::json!({
                    "status": "deleted",
                    "path": path,
                    "recursive": recursive,
                    "confirmedByUser": true,
                }),
                Err(e) => serde_json::json!({ "status": "error", "path": path, "error": e }),
            }
        }
        _ => serde_json::json!({ "status": "error", "error": "not a file op" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matching() {
        assert!(glob_match("", "anything"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*.txt", "readme.txt"));
        assert!(!glob_match("*.txt", "readme.md"));
        assert!(glob_match("*.TXT", "readme.txt")); // 忽略大小写
        // 尾部 * 吸收剩余内容：readme.* 匹配 readme.md
        assert!(glob_match("readme.*", "readme.md"));
        assert!(glob_match("readme.*", "readme."));
        assert!(!glob_match("readme.*", "readmeX"));
        // 末段锚定：a*b 不匹配 axby（b 必须到末尾）
        assert!(glob_match("a*b", "axb"));
        assert!(!glob_match("a*b", "axby"));
        assert!(glob_match("a*b*c", "aXbYc"));
        assert!(!glob_match("a*b*c", "ac"));
        assert!(glob_match("logs", "logs"));
        assert!(!glob_match("logs", "log"));
    }

    #[test]
    fn root_detection() {
        assert!(is_root(Path::new("C:\\")));
        assert!(is_root(Path::new("C:")));
        assert!(is_root(Path::new("\\")));
        assert!(is_root(Path::new("/")));
        assert!(!is_root(Path::new("C:\\Users")));
        assert!(!is_root(Path::new("C:\\Users\\x\\file.txt")));
        assert!(!is_root(Path::new("file.txt")));
    }

    #[test]
    fn read_validation() {
        // 空参数校验
        assert!(run_read(&serde_json::json!({})).is_err());
        // 不存在的文件应报错而非 panic
        let r = run_read(&serde_json::json!({ "path": "Z:\\no\\such\\file" }));
        assert!(r.is_err());
    }
}
