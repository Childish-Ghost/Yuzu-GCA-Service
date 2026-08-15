//! ConPTY 伪终端会话（手写 FFI，C-1 方案）。
//! 2026-08-07 签名实验确认：这台机器 kernel32 的 CreatePseudoConsole 签名是
//! （COORD size, hInput, hOutput, flags, phpc）——COORD 在前（与 conpty.dll 的
//! ConptyCreatePseudoConsole 一致），微软文档的官方签名（hInput 在前）在此
//! 机器返回 E_INVALIDARG。portable-pty 也按 COORD 签名声明，但其 flags 用了
//! WIN32_INPUT_MODE(0x4) 等组合（输入处理异常/无反应）——本实现 flags=0。
//!
//! 会话模型：读线程（输出字节流 → 订阅广播）+ 写输入 + 调整大小 + 关闭。
//! 输出分发：SSE 连接 subscribe() 拿到 Receiver，读线程推送所有订阅者。


use std::sync::atomic::{AtomicU64, AtomicU16, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::ffi::c_void;

// ---------------------------------------------------------------------------
// FFI 声明（Windows）
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod ffi {
    use super::*;

    pub type HPCON = *mut c_void;
    pub type HANDLE = *mut c_void;
    pub type HRESULT = i32;
    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type WORD = u16;
    pub type SHORT = i16;
    pub type SizeT = usize;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Coord {
        pub x: SHORT,
        pub y: SHORT,
    }

    #[repr(C)]
    pub struct SecurityAttributes {
        pub n_length: DWORD,
        pub lp_security_descriptor: *mut c_void,
        pub b_inherit_handle: BOOL,
    }

    #[repr(C)]
    pub struct StartupInfoW {
        pub cb: DWORD,
        pub lp_reserved: *mut u16,
        pub lp_desktop: *mut u16,
        pub lp_title: *mut u16,
        pub dw_x: DWORD,
        pub dw_y: DWORD,
        pub dw_x_size: DWORD,
        pub dw_y_size: DWORD,
        pub dw_x_count_chars: DWORD,
        pub dw_y_count_chars: DWORD,
        pub dw_fill_attribute: DWORD,
        pub dw_flags: DWORD,
        pub w_show_window: WORD,
        pub cb_reserved2: WORD,
        pub lp_reserved2: *mut u8,
        pub h_std_input: HANDLE,
        pub h_std_output: HANDLE,
        pub h_std_error: HANDLE,
    }

    #[repr(C)]
    pub struct StartupInfoExW {
        pub startup_info: StartupInfoW,
        pub lp_attribute_list: *mut c_void,
    }

    #[repr(C)]
    pub struct ProcessInformation {
        pub h_process: HANDLE,
        pub h_thread: HANDLE,
        pub dw_process_id: DWORD,
        pub dw_thread_id: DWORD,
    }

    pub const EXTENDED_STARTUPINFO_PRESENT: DWORD = 0x0008_0000;
    pub const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x0000_0400;
    pub const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

    unsafe extern "system" {
        pub fn CreatePipe(
            h_read: *mut HANDLE,
            h_write: *mut HANDLE,
            attrs: *const SecurityAttributes,
            size: DWORD,
        ) -> BOOL;
        pub fn CloseHandle(h: HANDLE) -> BOOL;
        // 本机签名（COORD 在前——2026-08-07 实测确认，官方 hInput 签名 E_INVALIDARG）
        pub fn CreatePseudoConsole(
            size: Coord,
            h_input: HANDLE,
            h_output: HANDLE,
            flags: DWORD,
            phpcon: *mut HPCON,
        ) -> HRESULT;
        pub fn ResizePseudoConsole(hpc: HPCON, size: Coord) -> HRESULT;
        pub fn ClosePseudoConsole(hpc: HPCON);
        pub fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: DWORD,
            flags: DWORD,
            size: *mut SizeT,
        ) -> BOOL;
        pub fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: DWORD,
            attribute: usize,
            value: *mut c_void,
            size: SizeT,
            prev: *mut c_void,
            ret: *mut SizeT,
        ) -> BOOL;
        pub fn DeleteProcThreadAttributeList(list: *mut c_void);
        pub fn CreateProcessW(
            app: *const u16,
            cmdline: *mut u16,
            proc_attrs: *const SecurityAttributes,
            thread_attrs: *const SecurityAttributes,
            inherit: BOOL,
            flags: DWORD,
            env: *mut c_void,
            cwd: *const u16,
            startup: *mut StartupInfoW,
            info: *mut ProcessInformation,
        ) -> BOOL;
        pub fn ReadFile(
            h: HANDLE,
            buf: *mut u8,
            n: DWORD,
            read: *mut DWORD,
            ov: *mut c_void,
        ) -> BOOL;
        pub fn WriteFile(
            h: HANDLE,
            buf: *const u8,
            n: DWORD,
            written: *mut DWORD,
            ov: *mut c_void,
        ) -> BOOL;
        pub fn SetHandleInformation(h: HANDLE, mask: DWORD, flags: DWORD) -> BOOL;
        pub fn LoadLibraryW(path: *const u16) -> HANDLE;
        pub fn WaitForSingleObject(h: HANDLE, ms: DWORD) -> DWORD;
        pub fn GetProcAddress(module: HANDLE, name: *const u8) -> *mut c_void;
        pub fn SetErrorMode(mode: DWORD) -> DWORD;
    }
}

type HPCON = *mut core::ffi::c_void;

/// 订阅通道容量（输出块缓冲；SSE 慢时丢弃慢订阅者）
const SUB_BUF: usize = 128;

/// 会话：ConPTY + 读线程 + 订阅广播
pub struct Session {
    #[cfg(target_os = "windows")]
    hpc: ffi::HPCON,
    /// 写输入（向 ConPTY 写键盘字节）
    #[cfg(target_os = "windows")]
    in_write: ffi::HANDLE,
    /// 读输出（从 ConPTY 读渲染字节）
    #[cfg(target_os = "windows")]
    out_read: ffi::HANDLE,
    /// 已关闭（幂等）
    #[cfg(target_os = "windows")]
    closed: std::sync::atomic::AtomicBool,
    /// shell 进程句柄（close 时 WaitForSingleObject 确保进程退出再开新会话）
    #[cfg(target_os = "windows")]
    child: std::sync::Mutex<Option<ffi::HANDLE>>,
    /// 会话是否存活（读线程运行中 = 子进程活着）。子进程 DLL 初始化失败
    /// （0xc0000142，ConPTY 上下文间歇性出现——机器级注入干扰）退出时读线程
    /// 结束 → alive=false → get_or_spawn 换新会话（死会话不阻塞重连）
    #[cfg(target_os = "windows")]
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// 订阅者（SSE 连接）。读线程推送；满/断连的订阅被移除。
    /// id 用于 SSE 连接退出时主动注销（否则死订阅者使 idle 回收永不触发）
    subs: Arc<Mutex<Vec<(usize, SyncSender<Vec<u8>>)>>>,
    /// 下一个订阅 id
    next_sub_id: std::sync::atomic::AtomicUsize,
    /// 启动输出缓冲（None=已有订阅者，停止积累）。第一个订阅者拿走
    startup: Arc<Mutex<Option<Vec<u8>>>>,
    /// 最后活跃时刻（毫秒时间戳，读/写线程刷新）
    last_active: Arc<AtomicU64>,
    pub shell: String,
    pub cols: AtomicU16,
    pub rows: AtomicU16,
}

/// 订阅注销句柄（SSE 连接退出时调用 Session::unsubscribe）
#[derive(Clone, Copy, Debug)]
pub struct Subscription {
    id: usize,
}

// 句柄跨线程安全：ClosePseudoConsole/ReadFile/WriteFile 均可由任意线程调用，
// close 有 AtomicBool 幂等保护（读线程阻塞中的 ReadFile 由 close 唤醒退出）
#[cfg(target_os = "windows")]
unsafe impl Send for Session {}
#[cfg(target_os = "windows")]
unsafe impl Sync for Session {}

/// 句柄的 Send 包装（读线程闭包捕获用）
#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct SendHandle(ffi::HANDLE);
#[cfg(target_os = "windows")]
unsafe impl Send for SendHandle {}
#[cfg(target_os = "windows")]
impl SendHandle {
    fn get(&self) -> ffi::HANDLE {
        self.0
    }
}

/// 动态加载 CreatePseudoConsole。
/// **默认系统 conhost（kernel32 CreatePseudoConsole）**——sideload
/// （conpty.dll + OpenConsole 当 ConPTY 主机）实测导致 PSReadLine 错误
/// 输出后输入回显差 1 行（行号偏移；wt 对照正常——wt 实际用系统 conhost）。
/// 2026-08-11 3012 隔离验证：conhost 主机下 cmd/PS 全流程渲染完美。
/// sideload 保留为显式开关（GCA_CONPTY_SIDELOAD=1）：踩坑史记录过
/// conhost 启动竞态（输入异常）——若回归可切回验证。
/// 返回 (函数指针, 是否 sideload)。函数签名 COORD 在前（本机实测）。
#[cfg(target_os = "windows")]
fn load_create_pc() -> (unsafe extern "system" fn(ffi::Coord, ffi::HANDLE, ffi::HANDLE, ffi::DWORD, *mut HPCON) -> ffi::HRESULT, bool) {
    unsafe extern "system" fn kern_create(
        size: ffi::Coord,
        h_in: ffi::HANDLE,
        h_out: ffi::HANDLE,
        flags: ffi::DWORD,
        php: *mut HPCON,
    ) -> ffi::HRESULT {
        ffi::CreatePseudoConsole(size, h_in, h_out, flags, php)
    }
    // sideload（conpty.dll + OpenConsole host）仅显式启用时尝试
    if std::env::var("GCA_CONPTY_SIDELOAD").as_deref() == Ok("1") {
        if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let path = dir.join("conpty.dll");
            if path.exists() {
                unsafe {
                    let wide: Vec<u16> = path.to_string_lossy().encode_utf16().chain(Some(0)).collect();
                    let hmod = ffi::LoadLibraryW(wide.as_ptr());
                    if !hmod.is_null() {
                        let fnptr = ffi::GetProcAddress(hmod, b"ConptyCreatePseudoConsole ".as_ptr().cast());
                        if !fnptr.is_null() {
                                crate::logging::log("conn", "ConPTY: sideloaded conpty.dll + OpenConsole (GCA_CONPTY_SIDELOAD=1)");
                                return (std::mem::transmute(fnptr), true);
                            }
                        }
                    }
                }
            }
        }
    }
    crate::logging::log("conn", "ConPTY: kernel32 (system conhost)");
    (kern_create, false)
}

#[cfg(target_os = "windows")]
fn create_pc(h_in: ffi::HANDLE, h_out: ffi::HANDLE, cols: ffi::SHORT, rows: ffi::SHORT, php: *mut HPCON) -> ffi::HRESULT {
    use std::sync::OnceLock;
    static FN: OnceLock<(unsafe extern "system" fn(ffi::Coord, ffi::HANDLE, ffi::HANDLE, ffi::DWORD, *mut HPCON) -> ffi::HRESULT, bool)> = OnceLock::new();
    let (f, _sideload) = FN.get_or_init(load_create_pc);
    unsafe { f(ffi::Coord { x: cols, y: rows }, h_in, h_out, 0, php) }
}

/// 当前毫秒时间戳
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// shell 启动命令（cmd 统一 chcp 65001 → UTF-8 输出；PS 设置控制台 IO 编码）
fn shell_command(shell: &str) -> (String, Vec<String>) {
    match shell {
        "powershell" => (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".into(),
                "-NoExit".into(),
                "-Command".into(),
                // 注：PSReadLine 曾因输入链路问题被 Remove-Module（无 PSReadLine 的
                // 基础模式在 ConPTY 下输出异常：双提示符/SGR 重复）。输入链路修复
                // （bInheritHandles=0 等）后恢复 PSReadLine——完整编辑体验。
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::InputEncoding=[Text.Encoding]::UTF8".into(),
            ],
        ),
        _ => (
            "cmd.exe".to_string(),
            vec!["/Q".into(), "/K".into(), "chcp 65001>nul & set PROMPT=$P$G".into()],
        ),
    }
}

impl Session {
    /// 启动 shell 于伪终端。cols/rows 为字符网格尺寸。
    #[cfg(target_os = "windows")]
    pub fn spawn(shell: &str, cols: u16, rows: u16) -> std::io::Result<Session> {
        use ffi::*;
        unsafe {
            let mut in_read: HANDLE = std::ptr::null_mut();
            let mut in_write: HANDLE = std::ptr::null_mut();
            let mut out_read: HANDLE = std::ptr::null_mut();
            let mut out_write: HANDLE = std::ptr::null_mut();
            // 输入管道：ConPTY 从 in_read 读，我们对 in_write 写
            if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // 输出管道：ConPTY 向 out_write 写，我们从 out_read 读
            if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
                CloseHandle(in_read);
                CloseHandle(in_write);
                return Err(std::io::Error::last_os_error());
            }
            // ConPTY 要求传入句柄可继承（否则 E_INVALIDARG）
            for h in [in_read, in_write, out_read, out_write] {
                SetHandleInformation(h, 1, 1);
            }
            // COORD 签名（本机实测）；flags=0。优先动态加载 conpty.dll
            // （配套 OpenConsole host——wt 同款，系统 conhost 启动竞态不可靠），
            // 失败回退 kernel32。
            let mut hpc: HPCON = std::ptr::null_mut();
            let hr = create_pc(in_read, out_write, cols as SHORT, rows as SHORT, &mut hpc);
            if hr < 0 {
                CloseHandle(in_read);
                CloseHandle(in_write);
                CloseHandle(out_read);
                CloseHandle(out_write);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("CreatePseudoConsole failed: 0x{hr:x}"),
                ));
            }
            // ConPTY 已持有管道内侧句柄
            CloseHandle(in_read);
            CloseHandle(out_write);

            // 进程属性列表：挂载伪控制台
            let mut attr_size: SizeT = 0;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
            let mut attr_list: Vec<u8> = vec![0u8; attr_size];
            let attr_ptr = attr_list.as_mut_ptr() as *mut c_void;
            if InitializeProcThreadAttributeList(attr_ptr, 1, 0, &mut attr_size) == 0 {
                ClosePseudoConsole(hpc);
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(std::io::Error::last_os_error());
            }
            if UpdateProcThreadAttribute(
                attr_ptr,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                hpc as *mut c_void,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) == 0
            {
                DeleteProcThreadAttributeList(attr_ptr);
                ClosePseudoConsole(hpc);
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(std::io::Error::last_os_error());
            }

            // 启动命令（含空格参数加引号——CreateProcess 按引号分组 argv）
            let (prog, args) = shell_command(shell);
            let cmdline_str = format!(
                "{} {}",
                prog,
                args.iter()
                    .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let mut cmdline: Vec<u16> = cmdline_str.encode_utf16().chain(Some(0)).collect();

            let mut si = StartupInfoExW {
                startup_info: StartupInfoW {
                    cb: std::mem::size_of::<StartupInfoExW>() as DWORD,
                    lp_reserved: std::ptr::null_mut(),
                    lp_desktop: std::ptr::null_mut(),
                    lp_title: std::ptr::null_mut(),
                    dw_x: 0,
                    dw_y: 0,
                    dw_x_size: 0,
                    dw_y_size: 0,
                    dw_x_count_chars: 0,
                    dw_y_count_chars: 0,
                    dw_fill_attribute: 0,
                    // STARTF_USESTDHANDLES + INVALID_HANDLE_VALUE（wt 同款）：
                    // shell 不继承 gca-term 的 stdio（ConPTY 通过 attribute 接管）
                    dw_flags: 0x00000100,
                    w_show_window: 0,
                    cb_reserved2: 0,
                    lp_reserved2: std::ptr::null_mut(),
                    h_std_input: -1isize as ffi::HANDLE,
                    h_std_output: -1isize as ffi::HANDLE,
                    h_std_error: -1isize as ffi::HANDLE,
                },
                lp_attribute_list: attr_ptr,
            };
            let mut pi = ProcessInformation {
                h_process: std::ptr::null_mut(),
                h_thread: std::ptr::null_mut(),
                dw_process_id: 0,
                dw_thread_id: 0,
            };
            let r = CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0, // bInheritHandles=FALSE（ConPTY 句柄经 attribute 传递——wt 同款）
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut si.startup_info,
                &mut pi,
            );
            DeleteProcThreadAttributeList(attr_ptr);
            if r == 0 {
                ClosePseudoConsole(hpc);
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(std::io::Error::last_os_error());
            }
            // 子进程由 ConPTY 托管；句柄保留给 close 时等进程退出
            // （切换时先回收旧 shell 再开新会话——避免残留/叠加）

            let subs = Arc::new(Mutex::new(Vec::<(usize, SyncSender<Vec<u8>>)>::new()));
            let startup = Arc::new(Mutex::new(Some(Vec::new())));
            let last_active = Arc::new(AtomicU64::new(now_ms()));

            // 读线程：阻塞读 → 广播给所有订阅者
            let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let t_subs = subs.clone();
            let t_active = last_active.clone();
            let t_startup = startup.clone();
            let t_alive = alive.clone();
            let t_out_read = SendHandle(out_read);
            let t_in_write = SendHandle(in_write);
            // shell 名（自动应答决策：cmd 需要启动兜底应答；PS 让 OpenConsole
            // 答真实位置——固定 \x1b[1;1R 会与真实位置（PS 启动横幅后光标在
            // 行 5 左右）冲突 → PSReadLine 初始行号偏移 1 → 错误输出后输入
            // 回显缩进 24（3012 逐键/批量均复现，wt 对照正常）
            let t_shell = shell.to_string();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                // CPR 自动应答兜底：cmd 启动时查询光标位置（\x1b[6n），不答
                // 则 cmd 卡死不处理输入。**只答一次且只在启动时**（cpr_answered
                // 标记）；**仅 cmd**——PS 启动查询由 OpenConsole 答真实位置。
                let mut cpr_answered = false;
                let mut tail = [0u8; 2];
                loop {
                    let mut read: DWORD = 0;
                    let ok = ReadFile(
                        t_out_read.get(),
                        buf.as_mut_ptr(),
                        buf.len() as DWORD,
                        &mut read,
                        std::ptr::null_mut(),
                    );
                    if ok == 0 || read == 0 {
                        break;
                    }
                    let n = read as usize;
                    if !cpr_answered && t_shell == "cmd" {
                        // cmd 启动查询应答（不阻塞读循环）：
                        //   \x1b[6n  CPR 光标位置 → \x1b[1;1R
                        //   \x1b[c   DA 设备属性   → \x1b[?62c
                        //   \x1b[>c  DA2 次级属性  → \x1b[>0;0;0c
                        // 不答则 cmd 卡在启动（无提示符、输入无反应）。
                        let mut check: Vec<u8> = tail.to_vec();
                        check.extend_from_slice(&buf[..n]);
                        // 只答 CPR（\x1b[6n）——DA（\x1b[c）由 conhost 处理，
                        // 我们答会混入 shell 输入（实测被 cmd 当命令执行）
                        let mut answers: Vec<&[u8]> = Vec::new();
                        if check.windows(3).any(|w| w == b"\x1b[6n") {
                            answers.push(b"\x1b[1;1R");
                        }
                        if !answers.is_empty() {
                            cpr_answered = true;
                            for a in answers {
                                let mut written: DWORD = 0;
                                WriteFile(
                                    t_in_write.get(),
                                    a.as_ptr(),
                                    a.len() as DWORD,
                                    &mut written,
                                    std::ptr::null_mut(),
                                );
                            }
                        }
                        if n >= 2 {
                            tail = [buf[n - 2], buf[n - 1]];
                        } else if n == 1 {
                            tail = [tail[1], buf[0]];
                        }
                    }
                    t_active.store(now_ms(), Ordering::Relaxed);
                    let chunk = buf[..n].to_vec();
                    // 启动缓冲：积累到第一个订阅者出现（上限 64KB）
                    {
                        let mut st = t_startup.lock().unwrap();
                        if let Some(buf) = st.as_mut() {
                            buf.extend_from_slice(&chunk);
                            if buf.len() > 65536 {
                                buf.drain(..buf.len() - 65536);
                            }
                        }
                    }
                    let mut dead = Vec::new();
                    {
                        let subs = t_subs.lock().unwrap();
                        for (i, (_, sub)) in subs.iter().enumerate() {
                            if sub.try_send(chunk.clone()).is_err() {
                                dead.push(i);
                            }
                        }
                    }
                    if !dead.is_empty() {
                        let mut subs = t_subs.lock().unwrap();
                        for i in dead.iter().rev() {
                            subs.remove(*i);
                        }
                    }
                }
                // 读线程退出：子进程已死（或会话关闭）→ 标记不存活
                t_alive.store(false, Ordering::SeqCst);
                // 通知订阅者
                let subs = t_subs.lock().unwrap();
                for (_, sub) in subs.iter() {
                    let _ = sub.send(Vec::new());
                }
            });

            Ok(Session {
                hpc,
                in_write,
                out_read,
                closed: std::sync::atomic::AtomicBool::new(false),
                child: std::sync::Mutex::new(Some(pi.h_process)),
                alive,
                subs,
                next_sub_id: std::sync::atomic::AtomicUsize::new(0),
                startup,
                last_active,
                shell: shell.to_string(),
                cols: AtomicU16::new(cols),
                rows: AtomicU16::new(rows),
            })
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn spawn(_shell: &str, _cols: u16, _rows: u16) -> std::io::Result<Session> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "ConPTY is Windows-only"))
    }

    /// 订阅输出流（返回 Receiver + 注销句柄）。第一个订阅者拿走启动缓冲。
    /// 连接方退出时必须 unsubscribe（否则死订阅者使 idle 回收永不触发）。
    pub fn subscribe(&self) -> (Receiver<Vec<u8>>, Subscription) {
        let (tx, rx) = sync_channel::<Vec<u8>>(SUB_BUF);
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let mut st = self.startup.lock().unwrap();
        if let Some(buf) = st.take() {
            if !buf.is_empty() {
                let _ = tx.try_send(buf);
            }
        }
        drop(st);
        self.subs.lock().unwrap().push((id, tx));
        (rx, Subscription { id })
    }

    /// 注销订阅（SSE 连接退出时调用）
    pub fn unsubscribe(&self, sub: &Subscription) {
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|(sid, _)| *sid != sub.id);
    }

    /// 写输入字节（键盘/粘贴）
    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        #[cfg(target_os = "windows")]
        {
            // C13 修复（2026-08-12 审查）：只记输入长度，不记字节内容——
            // 终端里输入的密码/密钥曾明文落盘 %APPDATA%\GCA Desktop\logs\gca-term.log
            crate::logging::log("input", &format!("[{}] input bytes: {}", self.shell, bytes.len()));
            self.last_active.store(now_ms(), Ordering::Relaxed);
            unsafe {
                let mut written: ffi::DWORD = 0;
                if ffi::WriteFile(self.in_write, bytes.as_ptr(), bytes.len() as ffi::DWORD, &mut written, std::ptr::null_mut()) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if written != bytes.len() as ffi::DWORD {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("partial write: {written}/{}", bytes.len()),
                    ));
                }
                Ok(())
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = bytes;
            Ok(())
        }
    }

    /// 调整尺寸（字符网格）
    pub fn resize(&self, cols: u16, rows: u16) {
        #[cfg(target_os = "windows")]
        unsafe {
            self.cols.store(cols, Ordering::Relaxed);
            self.rows.store(rows, Ordering::Relaxed);
            ffi::ResizePseudoConsole(self.hpc, ffi::Coord { x: cols as ffi::SHORT, y: rows as ffi::SHORT });
        }
    }

    /// 空闲毫秒数（用于 GCA_TERM_IDLE_MS 回收）
    pub fn idle_ms(&self) -> u64 {
        now_ms().saturating_sub(self.last_active.load(Ordering::Relaxed))
    }

    /// 会话是否存活（子进程读线程运行中）。假 = 子进程退出（含 DLL 初始化
    /// 失败 0xc0000142 秒退）——调用方应换新会话
    pub fn alive(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            self.alive.load(std::sync::atomic::Ordering::SeqCst)
        }
        #[cfg(not(target_os = "windows"))]
        {
            true
        }
    }

    /// 是否还有订阅者（SSE 连接在；死订阅者已由 unsubscribe 清理）
    pub fn has_subscribers(&self) -> bool {
        !self.subs.lock().unwrap().is_empty()
    }

    /// 关闭会话：结束 ConPTY（挂载进程一并结束）。幂等。
    pub fn close(&self) {
        #[cfg(target_os = "windows")]
        unsafe {
            if self.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            ffi::ClosePseudoConsole(self.hpc);
            // 等 shell 进程真正退出（回收完成）——避免切换时旧进程残留
            if let Some(h) = self.child.lock().unwrap().take() {
                ffi::WaitForSingleObject(h, 3000);
                ffi::CloseHandle(h);
            }
            ffi::CloseHandle(self.in_write);
            ffi::CloseHandle(self.out_read);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

/// 抑制子进程的 loader 错误弹窗（0xc0000142 DLL 初始化失败等）。
/// 错误模式会被子进程继承——ConPTY 拉起的 cmd/powershell 偶发 DLL 初始化
/// 失败时（机器级注入干扰，独立启动正常），Windows 不再弹「Application
/// Error」对话框（会话失败静默 → 桌面端自动重连，终端页无感恢复）。
/// 注意：需在 spawn 前调用（错误模式在进程创建时快照继承）。
#[cfg(target_os = "windows")]
pub fn suppress_child_error_dialogs() {
    const SEM_FAILCRITICALERRORS: ffi::DWORD = 0x0001;
    const SEM_NOGPFAULTERRORBOX: ffi::DWORD = 0x0002;
    const SEM_NOOPENFILEERRORBOX: ffi::DWORD = 0x8000;
    unsafe {
        ffi::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

/// 非 Windows 空实现（错误模式无对应语义）
#[cfg(not(target_os = "windows"))]
pub fn suppress_child_error_dialogs() {}
