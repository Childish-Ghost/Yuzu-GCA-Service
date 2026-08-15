#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod chat;
mod devdetail;
mod devices;
mod http;
mod localmcp;
mod login;
mod logs;
mod mdns;
mod scan;
mod termview;
mod tray;

use app::GcaApp;

/// 加载系统中文字体（微软雅黑/黑体/宋体）注册为 egui 默认字体的 fallback。
/// egui 内置字体不含 CJK 字形，不装的话中文全部渲染成「口」。
fn install_cjk_fonts(ctx: &egui::Context) {
    // 注意：egui 的字体解析（ab_glyph）不支持 .ttc 集合格式，只认 .ttf。
    // 微软雅黑 msyh.ttc 加载会静默失败——所以 ttf 排前面，ttc 仅兜底。
    const CANDIDATES: [&str; 7] = [
        r"C:\Windows\Fonts\simhei.ttf",   // 黑体
        r"C:\Windows\Fonts\Deng.ttf",     // 等线
        r"C:\Windows\Fonts\msyhbd.ttf",   // 雅黑粗体
        r"C:\Windows\Fonts\simsunb.ttf",  // 宋体
        r"C:\Windows\Fonts\simkai.ttf",   // 楷体
        r"C:\Windows\Fonts\msyh.ttc",     // 雅黑（ttc，兜底尝试）
        r"C:\Windows\Fonts\simsun.ttc",   // 宋体（ttc，兜底尝试）
    ];
    for path in CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let mut fonts = egui::FontDefinitions::default();
        fonts
            .font_data
            .insert("cjk".to_string(), std::sync::Arc::new(egui::FontData::from_owned(bytes)));
        // 追加到族末尾：英文仍用内置字体，CJK 字形回退到中文字体
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            if let Some(list) = fonts.families.get_mut(&family) {
                list.push("cjk".to_string());
            }
        }
        ctx.set_fonts(fonts);
        return;
    }
}

fn main() -> eframe::Result<()> {
    // 日志迁移（首次使用：旧日志归档）
    crate::logs::migrate_old_logs();
    // 单实例保护：已有实例（主窗口在）→ 直接退出（防双窗口双托盘图标）
    if crate::tray::already_running() {
        return Ok(());
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([980.0, 680.0])
            .with_min_inner_size([760.0, 520.0])
            .with_title("GCA Desktop")
            // 窗口标题栏图标用回 Tauri 版的 GCA logo
            .with_icon(crate::tray::logo_icon_data().unwrap_or(egui::IconData::default())),
        ..Default::default()
    };
    eframe::run_native(
        "GCA Desktop",
        options,
        Box::new(|cc| {
            install_cjk_fonts(&cc.egui_ctx);
            let mut app = GcaApp::default();
            app.init_tray();
            Ok(Box::new(app))
        }),
    )
}
