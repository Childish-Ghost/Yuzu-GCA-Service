//! process_list 工具：进程列表（只读）。PowerShell Get-Process → JSON 解析。
//! 过滤在解析后做（不拼接进命令行，无注入面）。

use std::process::Command;

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "process_list",
        description: "List running processes. Optional name filter, sort (cpu/memory/pid/name), and limit.",
        schema: serde_json::json!({
            "type": "object",
            "properties": {
                "filter": { "type": "string", "description": "Name substring filter" },
                "sort": { "type": "string", "enum": ["cpu", "memory", "pid", "name"], "description": "Sort order (default cpu)" },
                "limit": { "type": "number", "description": "Max rows (default 50)" }
            }
        }),
    }
}

pub fn run(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let filter = args.get("filter").and_then(|f| f.as_str()).unwrap_or("").to_lowercase();
    let sort = args.get("sort").and_then(|s| s.as_str()).unwrap_or("cpu").to_string();
    let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(50).min(500) as usize;

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // 输出 UTF-8 字节直写（chcp/OutputEncoding 在重定向时不可靠，实测）
        "Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json -Compress | ForEach-Object { $b=[System.Text.Encoding]::UTF8.GetBytes($_); [Console]::OpenStandardOutput().Write($b,0,$b.Length) }",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| format!("powershell failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    // Get-Process 空输出时 ConvertTo-Json 返回空字符串
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Array(vec![]));
    let rows: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    };

    let mut procs: Vec<(i64, String, Option<f64>, i64)> = rows
        .into_iter()
        .filter_map(|r| {
            let name = r.get("ProcessName").and_then(|n| n.as_str()).unwrap_or("").to_string();
            if !filter.is_empty() && !name.to_lowercase().contains(&filter) {
                return None;
            }
            let pid = r.get("Id").and_then(|p| p.as_i64()).unwrap_or(0);
            let cpu = r.get("CPU").and_then(|c| c.as_f64());
            let mem = r.get("WorkingSet64").and_then(|w| w.as_i64()).unwrap_or(0) / (1024 * 1024);
            Some((pid, name, cpu, mem))
        })
        .collect();

    match sort.as_str() {
        "memory" => procs.sort_by(|a, b| b.3.cmp(&a.3)),
        "pid" => procs.sort_by(|a, b| a.0.cmp(&b.0)),
        "name" => procs.sort_by(|a, b| a.1.cmp(&b.1)),
        _ => procs.sort_by(|a, b| b.2.unwrap_or(0.0).partial_cmp(&a.2.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)),
    }
    procs.truncate(limit);

    let processes: Vec<serde_json::Value> = procs
        .into_iter()
        .map(|(pid, name, cpu, mem)| {
            serde_json::json!({
                "pid": pid,
                "name": name,
                "cpuSec": cpu,
                "memoryMB": mem,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "status": "ok",
        "total": processes.len(),
        "returned": processes.len(),
        "sortBy": sort,
        "processes": processes,
    }))
}
