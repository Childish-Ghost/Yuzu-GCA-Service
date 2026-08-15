//! sysinfo 工具：系统信息快照（只读，无审批）。
//! 零依赖：一次 PowerShell 调用拿全量，输出 KEY=value 行解析。
//! 返回结构与 node 版一致（OpenClaw/AI 依赖字段名）。

use std::collections::HashMap;
use std::process::Command;

pub fn def() -> super::ToolDef {
    super::ToolDef {
        name: "sysinfo",
        description: "Get system information for this device: OS, CPU, memory, disk usage, network interfaces.",
        schema: serde_json::json!({ "type": "object", "properties": {} }),
    }
}

const PS_SCRIPT: &str = r#"
# 输出收集后 UTF-8 字节直写 stdout——PS 5.1 重定向/无控制台场景下
# chcp 与 OutputEncoding 均不可靠（实测），直写与代码页无关
$os=Get-CimInstance Win32_OperatingSystem
$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
$disk=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -First 1
$net=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1'} | Select-Object -First 4
$drives=Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object { $_.DeviceID }
$out = New-Object System.Collections.ArrayList
[void]$out.Add("HOST=" + $env:COMPUTERNAME)
[void]$out.Add("OS_CAPTION=" + $os.Caption)
[void]$out.Add("OS_VERSION=" + $os.Version)
[void]$out.Add("OS_ARCH=" + $os.OSArchitecture)
[void]$out.Add("OS_UPTIME_H=" + [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1))
[void]$out.Add("OS_TOTAL_MB=" + [math]::Round($os.TotalVisibleMemorySize / 1024))
[void]$out.Add("OS_FREE_MB=" + [math]::Round($os.FreePhysicalMemory / 1024))
[void]$out.Add("CPU_NAME=" + $cpu.Name)
[void]$out.Add("CPU_CORES=" + $cpu.NumberOfLogicalProcessors)
[void]$out.Add("CPU_MHZ=" + $cpu.MaxClockSpeed)
[void]$out.Add("DISK_PATH=" + $disk.DeviceID)
[void]$out.Add("DISK_TOTAL_GB=" + [math]::Round($disk.Size / 1GB, 1))
[void]$out.Add("DISK_FREE_GB=" + [math]::Round($disk.FreeSpace / 1GB, 1))
foreach ($n in $net) { [void]$out.Add("NET=" + $n.InterfaceAlias + "|" + $n.IPAddress) }
[void]$out.Add("DRIVES=" + ($drives -join ","))
$bytes = [System.Text.Encoding]::UTF8.GetBytes($out -join "`n")
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
"#;

pub fn run() -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| format!("powershell failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut kv: HashMap<String, String> = HashMap::new();
    let mut nets: Vec<serde_json::Value> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "NET" => {
                    if let Some((name, addr)) = v.split_once('|') {
                        nets.push(serde_json::json!({ "name": name, "address": addr }));
                    }
                }
                _ => {
                    kv.insert(k.to_string(), v.to_string());
                }
            }
        }
    }

    let total_mb: f64 = kv.get("OS_TOTAL_MB").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let free_mb: f64 = kv.get("OS_FREE_MB").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let used_mb = total_mb - free_mb;
    let used_percent = if total_mb > 0.0 { (used_mb / total_mb * 100.0 * 10.0).round() / 10.0 } else { 0.0 };
    let total_gb: f64 = kv.get("DISK_TOTAL_GB").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let free_gb: f64 = kv.get("DISK_FREE_GB").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let disk_used = if total_gb > 0.0 { ((total_gb - free_gb) / total_gb * 100.0 * 10.0).round() / 10.0 } else { 0.0 };

    Ok(serde_json::json!({
        "status": "ok",
        "hostname": kv.get("HOST").cloned().unwrap_or_default(),
        "os": {
            "platform": "win32",
            "type": "Windows_NT",
            "release": kv.get("OS_VERSION").cloned().unwrap_or_default(),
            "arch": kv.get("OS_ARCH").cloned().unwrap_or_default(),
            "uptimeHours": kv.get("OS_UPTIME_H").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
        },
        "cpu": {
            "model": kv.get("CPU_NAME").cloned().unwrap_or_default(),
            "cores": kv.get("CPU_CORES").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
            "speedMHz": kv.get("CPU_MHZ").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
            "loadAvg": [0.0, 0.0, 0.0],
            "loadAvgNote": "always [0,0,0] on Windows",
        },
        "memory": {
            "totalMB": total_mb,
            "freeMB": free_mb,
            "usedMB": used_mb,
            "usedPercent": used_percent,
        },
        "disk": {
            "path": kv.get("DISK_PATH").cloned().unwrap_or_default(),
            "totalGB": total_gb,
            "freeGB": free_gb,
            "usedPercent": disk_used,
        },
        "network": nets,
        "drives": kv.get("DRIVES").map(|s| s.split(',').filter(|d| !d.is_empty()).map(|d| d.to_string()).collect::<Vec<_>>()).unwrap_or_default(),
        "collectedAt": iso_now(),
    }))
}

/// UTC 时间戳（RFC3339 近似：YYYY-MM-DDTHH:MM:SSZ，无 chrono 依赖）
fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // 儒略日 → 公历（Howard Hinnant civil_from_days）
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}
