//! 系统托盘（Rust 原生 Win32，零依赖手写 FFI）——替代旧 PS 脚本方案。
//! 线程内建消息窗口 + Shell_NotifyIcon + 右键菜单：
//!   显示 → EnumWindows 找本进程主窗口 → SW_SHOW + SetForegroundWindow（唤醒不重启）
//!   退出 → 置 EXIT_REQUESTED 原子 + PostMessage WM_CLOSE（app 拦截放行优雅退出）
//! app 关闭窗口（X/Alt+F4）→ 拦截 → SW_HIDE 隐藏（egui 认为窗口仍可见，
//! 事件循环活跃，托盘唤醒后状态一致——这是绕开 egui 隐藏死区的关键）。

use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

/// 托盘请求退出（托盘线程置位，UI 拦截据此放行关闭）
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn exit_requested() -> bool {
    EXIT_REQUESTED.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Win32 FFI（零依赖手写）
// ---------------------------------------------------------------------------

type HWND = *mut core::ffi::c_void;
type HINSTANCE = *mut core::ffi::c_void;
type HICON = *mut core::ffi::c_void;
type HMENU = *mut core::ffi::c_void;
type HCURSOR = *mut core::ffi::c_void;
type HBRUSH = *mut core::ffi::c_void;
type LRESULT = isize;
type WPARAM = usize;
type LPARAM = isize;
type BOOL = i32;
type UINT = u32;
type DWORD = u32;
type WNDPROC = unsafe extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT;

const HWND_MESSAGE: HWND = -3isize as HWND;
const WM_APP: UINT = 0x8000;
const WM_DESTROY: UINT = 0x0002;
const WM_COMMAND: UINT = 0x0111;
const WM_CLOSE: UINT = 0x0010;
const WM_SYSCOMMAND: UINT = 0x0112;
const WM_RBUTTONUP: UINT = 0x0205;
const WM_LBUTTONDBLCLK: UINT = 0x0203;
const SW_HIDE: i32 = 0;
const SW_SHOW: i32 = 5;
const MF_STRING: UINT = 0x0000;
const TPM_RIGHTBUTTON: UINT = 0x0002;
const ID_SHOW: usize = 1;
const ID_EXIT: usize = 2;
const SC_CLOSE: WPARAM = 0xF060;

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Msg {
    hwnd: HWND,
    message: UINT,
    w_param: WPARAM,
    l_param: LPARAM,
    time: DWORD,
    pt: Point,
    l_private: DWORD,
}

#[repr(C)]
struct WndClassW {
    style: UINT,
    lpfn_wnd_proc: Option<WNDPROC>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: HINSTANCE,
    h_icon: HICON,
    h_cursor: HCURSOR,
    hbr_background: HBRUSH,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

/// NOTIFYICONDATAW（Vista+ 布局，Win10 实测）
#[repr(C)]
struct NotifyIconDataW {
    cb_size: DWORD,
    h_wnd: HWND,
    u_id: UINT,
    u_flags: UINT,
    u_callback_message: UINT,
    h_icon: HICON,
    sz_tip: [u16; 128],
    dw_state: DWORD,
    dw_state_mask: DWORD,
    sz_info: [u16; 256],
    u_version_or_timeout: UINT,
    sz_info_title: [u16; 64],
    dw_info_flags: DWORD,
    guid_item: [u8; 16],
    h_balloon_icon: HICON,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(wc: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex_style: DWORD,
        class_name: *const u16,
        window_name: *const u16,
        style: DWORD,
        x: i32, y: i32, w: i32, h: i32,
        parent: HWND, menu: HMENU, instance: HINSTANCE, param: *mut core::ffi::c_void,
    ) -> HWND;
    fn DefWindowProcW(h: HWND, m: UINT, w: WPARAM, l: LPARAM) -> LRESULT;
    fn GetMessageW(msg: *mut Msg, h: HWND, min: UINT, max: UINT) -> BOOL;
    fn TranslateMessage(msg: *const Msg) -> BOOL;
    fn DispatchMessageW(msg: *const Msg) -> LRESULT;
    fn PostQuitMessage(code: i32);
    fn Shell_NotifyIconW(msg: DWORD, data: *const NotifyIconDataW) -> BOOL;
    fn CreatePopupMenu() -> HMENU;
    fn AppendMenuW(menu: HMENU, flags: UINT, id: usize, text: *const u16) -> BOOL;
    fn TrackPopupMenu(menu: HMENU, flags: UINT, x: i32, y: i32, reserved: i32, h: HWND, rect: *const core::ffi::c_void) -> BOOL;
    fn DestroyMenu(menu: HMENU) -> BOOL;
    fn GetCursorPos(pt: *mut Point) -> BOOL;
    fn EnumWindows(cb: Option<unsafe extern "system" fn(HWND, LPARAM) -> BOOL>, l: LPARAM) -> BOOL;
    fn GetWindowThreadProcessId(h: HWND, pid: *mut DWORD) -> DWORD;
    fn GetWindowTextW(h: HWND, s: *mut u16, max: i32) -> i32;
    fn ShowWindow(h: HWND, cmd: i32) -> BOOL;
    fn SetForegroundWindow(h: HWND) -> BOOL;
    fn PostMessageW(h: HWND, m: UINT, w: WPARAM, l: LPARAM) -> BOOL;
    fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    fn LoadIconW(instance: HINSTANCE, name: *const u16) -> HICON;
    fn FindWindowW(class: *const u16, title: *const u16) -> HWND;
    fn LoadImageW(
        instance: HINSTANCE,
        name: *const u16,
        typ: UINT,
        cx: i32,
        cy: i32,
        flags: UINT,
    ) -> HICON;
    fn GetIconInfo(h_icon: HICON, info: *mut IconInfo) -> BOOL;
    fn GetObjectW(h: *mut core::ffi::c_void, size: i32, out: *mut core::ffi::c_void) -> i32;
    fn GetDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, dc: HDC) -> i32;
    fn GetDIBits(
        dc: HDC,
        hbm: HBITMAP,
        start: UINT,
        lines: UINT,
        buf: *mut core::ffi::c_void,
        bmi: *mut BitmapInfo,
        usage: UINT,
    ) -> i32;
    fn DeleteObject(h: *mut core::ffi::c_void) -> BOOL;
}

type HDC = *mut core::ffi::c_void;
type HBITMAP = *mut core::ffi::c_void;

#[repr(C)]
struct Bitmap {
    bm_type: i32,
    bm_width: i32,
    bm_height: i32,
    bm_width_bytes: i32,
    bm_planes: u16,
    bm_bits_pixel: u16,
    bm_bits: *mut core::ffi::c_void,
}

#[repr(C)]
struct IconInfo {
    f_icon: BOOL,
    x_hotspot: DWORD,
    y_hotspot: DWORD,
    hbm_mask: HBITMAP,
    hbm_color: HBITMAP,
}

#[repr(C)]
struct BitmapInfoHeader {
    bi_size: DWORD,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: DWORD,
    bi_size_image: DWORD,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: DWORD,
    bi_clr_important: DWORD,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [DWORD; 3],
}

const NIM_ADD: DWORD = 0;
const NIM_DELETE: DWORD = 2;
const NIF_MESSAGE: UINT = 0x1;
const NIF_ICON: UINT = 0x2;
const NIF_TIP: UINT = 0x4;
const IDI_APPLICATION: *const u16 = 32512 as *const u16;
const CALLBACK_MSG: UINT = WM_APP + 1;
const IMAGE_ICON: UINT = 1;
const LR_LOADFROMFILE: UINT = 0x10;

/// GCA logo（Tauri 版图标，沿用之前的 logo）
const GCA_LOGO_ICO: &[u8] = include_bytes!("../resources/icon.ico");

/// 从嵌入的 ICO 创建 HICON（托盘 + 窗口图标共用）。
/// 用 LoadImageW(LR_LOADFROMFILE)：ICO 条目是 PNG 压缩存储（Tauri 的
/// PNG-in-ICO），CreateIconFromResourceEx 不认 PNG 条目（返回 0，实测）；
/// LoadImage 由 shell 解码，写临时文件加载后即删。
fn logo_icon() -> HICON {
    let tmp = std::env::temp_dir().join(format!("gca-logo-{}.ico", std::process::id()));
    let _ = std::fs::write(&tmp, GCA_LOGO_ICO);
    let path = wide(&tmp.to_string_lossy());
    let h = unsafe {
        LoadImageW(
            std::ptr::null_mut(),
            path.as_ptr(),
            IMAGE_ICON,
            32,
            32,
            LR_LOADFROMFILE,
        )
    };
    let _ = std::fs::remove_file(&tmp);
    h
}

/// 从 logo HICON 取 RGBA 像素（egui 窗口图标用）。
/// 链路：GetIconInfo → GetObject(BITMAP) → GetDIBits（top-down 负高度）——
/// 纯 Win32，绕开 ICO 内部 PNG 压缩（Tauri 的 PNG-in-ICO 无法手写解码）。
pub fn logo_icon_data() -> Option<egui::IconData> {
    let hicon = logo_icon();
    if hicon.is_null() {
        return None;
    }
    unsafe {
        let mut ii: IconInfo = std::mem::zeroed();
        if GetIconInfo(hicon, &mut ii) == 0 {
            return None;
        }
        let mut bm: Bitmap = std::mem::zeroed();
        if GetObjectW(ii.hbm_color, std::mem::size_of::<Bitmap>() as i32, &mut bm as *mut _ as *mut core::ffi::c_void) == 0 {
            return None;
        }
        let (w, h) = (bm.bm_width as u32, bm.bm_height as u32);
        let hdc = GetDC(std::ptr::null_mut());
        let mut bmi: BitmapInfo = std::mem::zeroed();
        bmi.header.bi_size = 40;
        bmi.header.bi_width = w as i32;
        bmi.header.bi_height = -(h as i32); // 负高度 = top-down
        bmi.header.bi_planes = 1;
        bmi.header.bi_bit_count = 32;
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let got = GetDIBits(
            hdc,
            ii.hbm_color,
            0,
            h,
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut bmi,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        DeleteObject(ii.hbm_color);
        DeleteObject(ii.hbm_mask);
        if got == 0 {
            return None;
        }
        // BGRA → RGBA（top-down，行序与 egui 一致）
        let mut rgba = Vec::with_capacity(buf.len());
        for px in buf.chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
        Some(egui::IconData { rgba, width: w, height: h })
    }
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

/// 单实例检查：已有标题为 "GCA Desktop" 的顶层窗口（另一个实例）？
pub fn already_running() -> bool {
    let title = wide("GCA Desktop");
    unsafe {
        // FindWindowW 声明到 extern 块里（下面补充）
        !FindWindowW(std::ptr::null(), title.as_ptr()).is_null()
    }
}

/// 找本进程主窗口（标题非空的顶层窗口）。
/// extern fn 回调无闭包捕获，用 static 传 PID/结果（hide 在 UI 线程、
/// show 在托盘线程，几乎不会并发；注释此限制）。
static FIND_PID: AtomicU32 = AtomicU32::new(0);
static FIND_RESULT: AtomicUsize = AtomicUsize::new(0);

unsafe extern "system" fn find_cb(hwnd: HWND, _l: LPARAM) -> BOOL {
    let target = FIND_PID.load(Ordering::SeqCst);
    let mut pid: DWORD = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == target {
        let mut buf = [0u16; 256];
        if GetWindowTextW(hwnd, buf.as_mut_ptr(), 256) > 0 {
            FIND_RESULT.store(hwnd as usize, Ordering::SeqCst);
            return 0; // 找到，停止枚举
        }
    }
    1
}

fn main_window_handle() -> HWND {
    FIND_PID.store(std::process::id(), Ordering::SeqCst);
    FIND_RESULT.store(0, Ordering::SeqCst);
    unsafe {
        EnumWindows(Some(find_cb), 0);
    }
    FIND_RESULT.load(Ordering::SeqCst) as HWND
}

/// 显示本进程主窗口（托盘「显示」/双击）
pub fn show_window() {
    let h = main_window_handle();
    if h.is_null() {
        return;
    }
    unsafe {
        ShowWindow(h, SW_SHOW);
        SetForegroundWindow(h);
    }
}

/// 隐藏本进程主窗口（app 关闭拦截调用）
pub fn hide_window() {
    let h = main_window_handle();
    if h.is_null() {
        return;
    }
    unsafe {
        ShowWindow(h, SW_HIDE);
    }
}

/// 托盘「退出」：置位 + 发关闭消息触发 app 优雅退出（拦截放行）。
/// 加固（2026-08-06 用户反馈点击无响应）：
///   - FindWindowW 按标题直找（不依赖 EnumWindows 枚举）
///   - WM_CLOSE + WM_SYSCOMMAND SC_CLOSE 双发（winit 两者都认）
///   - 2 秒兜底强制退出（托盘线程内 process::exit——凭据登录时已落盘，不丢数据）
fn request_exit() {
    EXIT_REQUESTED.store(true, Ordering::Relaxed);
    let title = wide("GCA Desktop");
    let h = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if !h.is_null() {
        unsafe {
            PostMessageW(h, WM_CLOSE, 0, 0);
            PostMessageW(h, WM_SYSCOMMAND, SC_CLOSE, 0);
        }
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
}

/// 启动托盘线程（内嵌于 app 进程）
pub fn spawn() -> bool {
    std::thread::Builder::new()
        .name("gca-tray".into())
        .spawn(tray_thread)
        .is_ok()
}

fn tray_thread() {
    unsafe {
        // 窗口类
        let class_name = wide("GcaTrayWindow");
        let wc = WndClassW {
            style: 0,
            lpfn_wnd_proc: Some(tray_wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: GetModuleHandleW(std::ptr::null()),
            h_icon: std::ptr::null_mut(),
            h_cursor: std::ptr::null_mut(),
            hbr_background: std::ptr::null_mut(),
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            return;
        }
        // message-only 窗口（托盘事件接收器）
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            0,
            0, 0, 0, 0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            wc.h_instance,
            std::ptr::null_mut(),
        );
        if hwnd.is_null() {
            return;
        }

        // 图标：GCA logo（嵌入 ICO），失败兜底系统应用图标
        let icon = logo_icon();
        let icon = if icon.is_null() { LoadIconW(std::ptr::null_mut(), IDI_APPLICATION) } else { icon };

        // 托盘图标
        let mut nid: NotifyIconDataW = std::mem::zeroed();
        nid.cb_size = std::mem::size_of::<NotifyIconDataW>() as DWORD;
        nid.h_wnd = hwnd;
        nid.u_id = 1;
        nid.u_flags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.u_callback_message = CALLBACK_MSG;
        nid.h_icon = icon;
        let tip = wide("GCA Desktop — 全局控制助手");
        let mut i = 0;
        for c in tip.iter().take(127) {
            nid.sz_tip[i] = *c;
            i += 1;
        }
        Shell_NotifyIconW(NIM_ADD, &nid);

        // 消息循环
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

unsafe extern "system" fn tray_wnd_proc(hwnd: HWND, msg: UINT, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    match msg {
        CALLBACK_MSG => {
            match l_param as u32 {
                WM_RBUTTONUP => {
                    // 右键菜单
                    let menu = CreatePopupMenu();
                    if !menu.is_null() {
                        let show = wide("显示 / 打开窗口");
                        let exit = wide("退出");
                        AppendMenuW(menu, MF_STRING, ID_SHOW, show.as_ptr());
                        AppendMenuW(menu, MF_STRING, ID_EXIT, exit.as_ptr());
                        let mut pt = Point { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, std::ptr::null());
                        DestroyMenu(menu);
                    }
                }
                WM_LBUTTONDBLCLK => show_window(),
                _ => {}
            }
            0
        }
        WM_COMMAND => {
            match w_param & 0xFFFF {
                ID_SHOW => show_window(),
                ID_EXIT => request_exit(),
                _ => {}
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, w_param, l_param),
    }
}
