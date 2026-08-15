use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use std::sync::Mutex;
use std::process::{Child, Command, Stdio};
use std::path::PathBuf;

#[tauri::command]
fn get_hostname() -> String {
    hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default()
}

/// 隐藏控制台窗口（Windows: CREATE_NO_WINDOW=0x08000000）。
/// 所有从 GUI 进程 spawn 的控制台命令（netstat/wmic/taskkill/powershell…）
/// 都必须走这里，否则启动时会闪现 cmd/PS 黑窗。
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000)
}

#[tauri::command]
fn start_gca(app: tauri::AppHandle) -> Result<String, String> {
    // 登录后由前端调用，启动 gca-poc 子进程
    let state = app.state::<GcaChild>();
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Ok("gca-poc already running".to_string());
    }
    let node = find_node(&app);
    let bundle = find_bundle(&app);
    let gca_token = load_config_token().unwrap_or_default();
    if gca_token.is_empty() {
        return Err("no token configured".to_string());
    }
    let child = spawn_gca_hidden(&node, &bundle, &gca_token)?;
    *guard = Some(child);
    Ok(format!("gca-poc started: {}", bundle.display()))
}

/// 启动 gca-poc 并完全隐藏控制台窗口。
/// Windows: DETACHED_PROCESS + CREATE_NO_WINDOW 组合，杜绝 node 控制台闪现。
#[cfg(target_os = "windows")]
/// 清理残留的旧 gca-poc 进程（覆盖安装/崩溃后遗留，占用 3001 端口）。
/// 只杀确认是 gca-poc 的进程（cmdline 含 gca-bundle.cjs），不乱杀。
fn cleanup_stale_gca() {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command as PCommand;
        // 查 3001 端口占用者
        let out = no_window(&mut PCommand::new("netstat.exe"))
            .args(["-ano"])
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if !line.contains(":3001") || !line.contains("LISTENING") { continue; }
                // 提取 PID（行尾）
                let pid = line.split_whitespace().last().unwrap_or("").to_string();
                if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) { continue; }
                // 确认该 PID 是 gca-poc
                let info = no_window(&mut PCommand::new("wmic.exe"))
                    .args(["process", "where", &format!("ProcessId={pid}"), "get", "CommandLine"])
                    .output();
                if let Ok(info) = info {
                    let cmdline = String::from_utf8_lossy(&info.stdout);
                    if cmdline.contains("gca-bundle.cjs") {
                        println!("cleaning stale gca-poc pid={pid}");
                        let _ = no_window(&mut PCommand::new("taskkill.exe")).args(["/F", "/PID", &pid]).output();
                    }
                }
            }
        }
    }
}

fn spawn_gca_hidden(node: &PathBuf, bundle: &PathBuf, gca_token: &str) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    // 覆盖安装/崩溃后可能残留旧 gca-poc 占着 3001，先清理
    cleanup_stale_gca();
    let machine_id = get_machine_id();
    let log_path = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("gca-poc.log"))
        .unwrap_or_default();
    let log_file = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg(bundle)
        .stdout(Stdio::from(log_file.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log_file))
        .env("GCA_MCP_TOKEN", gca_token);
    if !machine_id.is_empty() {
        cmd.env("GCA_MACHINE_ID", &machine_id);
    }
    cmd.env("GCA_AUTO_REGISTER", "0");
    cmd.env("GCA_CLIPBOARD_SYNC", "0");
    // DETACHED_PROCESS(0x8) | CREATE_NO_WINDOW(0x08000000) = 0x08000008
    cmd.creation_flags(0x08000008);
    cmd.spawn().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_gca_hidden(node: &PathBuf, bundle: &PathBuf, gca_token: &str) -> Result<std::process::Child, String> {
    let machine_id = get_machine_id();
    let mut cmd = Command::new(node);
    cmd.arg(bundle)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("GCA_MCP_TOKEN", gca_token);
    if !machine_id.is_empty() {
        cmd.env("GCA_MACHINE_ID", &machine_id);
    }
    cmd.env("GCA_AUTO_REGISTER", "0");
    cmd.env("GCA_CLIPBOARD_SYNC", "0");
    cmd.spawn().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(token: String, server_url: String) -> Result<(), String> {
    let config_path = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("config.json"))
        .map_err(|e| e.to_string())?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::json!({ "token": token, "serverUrl": server_url });
    std::fs::write(&config_path, serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_machine_id() -> String {
    // Windows: SMBIOS System UUID (firmware-level, survives OS reinstall)
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let output = no_window(&mut Command::new("powershell.exe"))
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"])
            .output();
        if let Ok(out) = output {
            let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !id.is_empty() && id != "Not Specified" && id != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" {
                return id;
            }
        }
    }
    // Linux: SMBIOS product_uuid (same source as Windows)
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = std::fs::read_to_string("/sys/class/dmi/id/product_uuid") {
            let id = id.trim().to_string();
            if !id.is_empty() && id != "Not Specified" {
                return id;
            }
        }
    }
    // fallback: hostname
    hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
async fn http_get(url: String, token: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn http_post_headers(url: String, token: String, body: String, headers: String) -> Result<String, String> {
    // headers: JSON 对象 {"header-name": "value"}，用于 MCP session 管理
    // 返回: {"body": "...", "headers": {"mcp-session-id": "..."}}
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body);
    if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&headers) {
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    req = req.header(k.as_str(), s);
                }
            }
        }
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    // 先提取响应头（mcp-session-id）——reqwest 对非标准 header 可能转小写/加前缀
    let mut resp_headers = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), serde_json::Value::String(s.to_string()));
        }
    }
    // 调试：写文件查看 headers
    if let Ok(d) = std::env::var("APPDATA") {
        let dbg_path = PathBuf::from(d).join("GCA Desktop").join("mcp-debug.log");
        let line = format!("headers: {:?}\n", resp_headers);
        let _ = std::fs::OpenOptions::new().append(true).create(true).open(&dbg_path)
            .and_then(|mut f| { use std::io::Write; f.write_all(line.as_bytes()) });
    }
    let resp_body = resp.text().await.map_err(|e| e.to_string())?;
    let result = serde_json::json!({ "body": resp_body, "headers": resp_headers });
    Ok(result.to_string())
}

#[tauri::command]
async fn http_post(url: String, token: String, body: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    resp.text().await.map_err(|e| e.to_string())
}

struct GcaChild(Mutex<Option<Child>>);

fn find_node(app: &tauri::AppHandle) -> PathBuf {
    // 1. 打包的 node.exe（最优先）
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bundled = resource_dir.join("node.exe");
    if bundled.exists() {
        return bundled;
    }
    // 2. 开发模式: 资源目录
    let dev_node = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("node.exe");
    if dev_node.exists() {
        return dev_node;
    }
    // 3. 系统 PATH
    PathBuf::from("node")
}

/// 从本地配置文件读取 gca-server token（不硬编码）。
/// 配置文件: %APPDATA%/GCA Desktop/config.json
fn load_config_token() -> Option<String> {
    // 1. 环境变量优先（运维可注入）
    if let Ok(t) = std::env::var("GCA_SERVER_TOKEN") {
        if !t.is_empty() { return Some(t); }
    }
    // 2. 本地配置文件（Desktop 登录时写入）
    let config_path = std::env::var("APPDATA")
        .map(|d| PathBuf::from(d).join("GCA Desktop").join("config.json"))
        .unwrap_or_default();
    if let Ok(text) = std::fs::read_to_string(&config_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(t) = json.get("token").and_then(|v| v.as_str()) {
                if !t.is_empty() { return Some(t.to_string()); }
            }
        }
    }
    None
}

fn find_bundle(app: &tauri::AppHandle) -> PathBuf {
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bundled = resource_dir.join("gca-bundle.cjs");
    if bundled.exists() { return bundled; }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("gca-bundle.cjs");
    if dev_path.exists() { return dev_path; }
    bundled
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(GcaChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![http_get, http_post, http_post_headers, get_hostname, get_machine_id, save_config, start_gca])
        .setup(|app| {
            // 开机自启动
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }
            // ── 启动 gca-poc 子进程（仅当已保存配置，避免首次登录前弹窗）──
            let node = find_node(app.handle());
            let bundle = find_bundle(app.handle());
            let gca_token = load_config_token().unwrap_or_default();
            let child = if gca_token.is_empty() {
                println!("gca-poc 未启动（未登录，无 token）");
                None
            } else {
                spawn_gca_hidden(&node, &bundle, &gca_token).ok()
            };
            if let Some(c) = child {
                *app.state::<GcaChild>().0.lock().unwrap() = Some(c);
                println!("gca-poc started (node={}, bundle={})", node.display(), bundle.display());
            }

            // ── gca-poc 崩溃自动重启 ──
            let node_clone = node.clone();
            let bundle_clone = bundle.clone();
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    let exited = {
                        let state = app_handle.state::<GcaChild>();
                        let mut guard = state.0.lock().unwrap();
                        if let Some(ref mut child) = *guard {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    println!("gca-poc exited: {status}, restarting in 3s...");
                                    true
                                }
                                _ => false,
                            }
                        } else {
                            false
                        }
                    };
                    if !exited {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        continue;
                    }
                    // 重启（隐藏窗口）
                    let gca_token = load_config_token().unwrap_or_default();
                    if gca_token.is_empty() {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        continue;
                    }
                    match spawn_gca_hidden(&node_clone, &bundle_clone, &gca_token) {
                        Ok(c) => {
                            *app_handle.state::<GcaChild>().0.lock().unwrap() = Some(c);
                            println!("gca-poc restarted");
                        }
                        Err(e) => {
                            eprintln!("gca-poc restart failed: {e}");
                            std::thread::sleep(std::time::Duration::from_secs(5));
                        }
                    }
                }
            });

            // ── 系统托盘菜单 ──
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "quit", "退出 GCA", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &exit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── 关闭按钮 → 隐藏到托盘 ──
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    window_clone.hide().unwrap();
                    api.prevent_close();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // ── 退出时杀掉 gca-poc ──
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Ok(mut guard) = app.state::<GcaChild>().0.lock() {
                    if let Some(ref mut child) = *guard {
                        let _ = child.kill();
                        println!("gca-poc killed");
                    }
                }
            }
        });
}
