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

fn find_bundle(app: &tauri::AppHandle) -> PathBuf {
    // Tauri resource_dir 放打包后的资源
    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bundled = resource_dir.join("gca-bundle.cjs");
    if bundled.exists() {
        return bundled;
    }
    // 开发模式: 从源码目录找
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..").join("poc").join("dist").join("gca-bundle.cjs");
    if dev_path.exists() {
        return dev_path;
    }
    bundled
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(GcaChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![http_get, http_post, get_hostname])
        .setup(|app| {
            // ── 启动 gca-poc 子进程 ──
            let node = find_node(app.handle());
            let bundle = find_bundle(app.handle());
            let child = Command::new(&node)
                .arg(&bundle)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match child {
                Ok(c) => {
                    *app.state::<GcaChild>().0.lock().unwrap() = Some(c);
                    println!("gca-poc started (node={}, bundle={})", node.display(), bundle.display());
                }
                Err(e) => {
                    eprintln!("gca-poc failed to start: {e}");
                }
            }

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
