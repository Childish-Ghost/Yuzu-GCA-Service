//! Android JNI 桥（cfg(target_os="android")）——手写最小 JNI FFI（零依赖，
//! 对齐 desktop-rs tray.rs「零依赖手写 FFI」先例）。
//!
//! 单向（P1）：Java → Rust：`NativeBridge.nativeStart(port, token, deviceName, serverUrl)`
//! 双向（P2）：Rust → Java：agent 工具回调系统能力（剪贴板/截图/通知/远程输入），
//!   经 JavaVM AttachCurrentThread 拿线程 JNIEnv（agent 线程是纯 Rust spawn 的）。
//!
//! 要点：
//! - **Android 无自定义进程 env**（Zygote 固定）→ 用 `std::env::set_var` 注入
//!   （进程内存 environ，agent config.rs 的 std::env::var 可读，零改动）
//! - agent 服务线程是纯 Rust 网络（http::serve），需要时 with_java 临时 attach
//! - 日志走 logcat（liblog，build.rs 按 target_os=android 链接 -llog）

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicPtr, Ordering};

use crate::{agent_server, config};

// ---------- JNI 最小类型（JNI 规范） ----------

#[repr(C)]
pub struct _jobject {
    _unused: [u8; 0],
}
pub type jobject = *mut _jobject;
pub type jclass = jobject;
pub type jstring = jobject;
pub type jint = i32;
pub type jboolean = u8;
pub type jbyte = i8;

const JNI_OK: jint = 0;
const JNI_VERSION_1_6: jint = 0x0001_0006;

/// JNIEnv 函数表（索引以 NDK 27 jni.h 为准，逐项核对；函数指针 64 位下与 usize 同宽）
#[repr(C)]
pub struct JNINativeInterface {
    pad0: [usize; 6], // 0-5（reserved + GetVersion + DefineClass）
    // 6: FindClass
    pub find_class: unsafe extern "system" fn(env: *mut JNIEnv, name: *const c_char) -> jclass,
    pad00: [usize; 10], // 7-16
    // 17: ExceptionClear
    pub exception_clear: unsafe extern "system" fn(env: *mut JNIEnv),
    pad01: [usize; 3], // 18-20
    // 21: NewGlobalRef
    pub new_global_ref: unsafe extern "system" fn(env: *mut JNIEnv, obj: jobject) -> jobject,
    pad1: [usize; 91], // 22-112
    // 113: GetStaticMethodID
    pub get_static_method_id:
        unsafe extern "system" fn(env: *mut JNIEnv, cls: jclass, name: *const c_char, sig: *const c_char) -> *mut c_void,
    // 114: CallStaticObjectMethod
    pub call_static_object_method: unsafe extern "system" fn(env: *mut JNIEnv, cls: jclass, mid: *mut c_void, ...) -> jobject,
    pad2: [usize; 2], // 115-116（V/A 变体）
    // 117: CallStaticBooleanMethod
    pub call_static_boolean_method:
        unsafe extern "system" fn(env: *mut JNIEnv, cls: jclass, mid: *mut c_void, ...) -> jboolean,
    pad3: [usize; 23], // 118-140
    // 141: CallStaticVoidMethod
    pub call_static_void_method: unsafe extern "system" fn(env: *mut JNIEnv, cls: jclass, mid: *mut c_void, ...),
    pad4: [usize; 25], // 142-166
    // 167: NewStringUTF
    pub new_string_utf: unsafe extern "system" fn(env: *mut JNIEnv, utf: *const c_char) -> jstring,
    pad5: [usize; 1], // 168（GetStringUTFLength）
    // 169/170: Get/ReleaseStringUTFChars
    pub get_string_utf_chars:
        unsafe extern "system" fn(env: *mut JNIEnv, s: jstring, is_copy: *mut u8) -> *const c_char,
    pub release_string_utf_chars: unsafe extern "system" fn(env: *mut JNIEnv, s: jstring, utf: *const c_char),
    // 171: GetArrayLength
    pub get_array_length: unsafe extern "system" fn(env: *mut JNIEnv, arr: jobject) -> jint,
    pad6: [usize; 4], // 172-175（NewObjectArray/GetObjectArrayElement/SetObjectArrayElement/NewBooleanArray）
    // 176: NewByteArray
    pub new_byte_array: unsafe extern "system" fn(env: *mut JNIEnv, len: jint) -> jobject,
    pad7: [usize; 7], // 177-183（NewCharArray..GetBooleanArrayElements）
    // 184: GetByteArrayElements
    pub get_byte_array_elements:
        unsafe extern "system" fn(env: *mut JNIEnv, arr: jobject, is_copy: *mut u8) -> *mut jbyte,
    pad8: [usize; 7], // 185-191（GetCharArrayElements..ReleaseBooleanArrayElements）
    // 192: ReleaseByteArrayElements
    pub release_byte_array_elements:
        unsafe extern "system" fn(env: *mut JNIEnv, arr: jobject, elems: *mut jbyte, mode: jint),
    pad9: [usize; 26], // 193-218（Get*ArrayRegion 等，不用）
    // 219: GetJavaVM
    pub get_java_vm: unsafe extern "system" fn(env: *mut JNIEnv, vm: *mut *mut JavaVM) -> jint,
    pad10: [usize; 8], // 220-227
    // 228: ExceptionCheck（注意：201 是 GetCharArrayRegion——勿错位！）
    pub exception_check: unsafe extern "system" fn(env: *mut JNIEnv) -> jboolean,
}

#[repr(C)]
pub struct JNIEnv {
    pub functions: *const JNINativeInterface,
}

/// JavaVM（**Android ART 无 reserved——functions 在偏移 0**，与标准 jni.h 不同！
/// 标准实现（HotSpot）有 reserved0/1；这里必须与目标平台一致）
#[repr(C)]
pub struct JavaVM {
    pub functions: *const JavaVMInvokeInterface,
}

#[repr(C)]
pub struct JavaVMInvokeInterface {
    reserved: [usize; 3], // 0-2
    // 3: DestroyJavaVM（不用）
    pub destroy_java_vm: unsafe extern "system" fn(vm: *mut JavaVM) -> jint,
    // 4: AttachCurrentThread
    pub attach_current_thread:
        unsafe extern "system" fn(vm: *mut JavaVM, penv: *mut *mut c_void, args: *mut c_void) -> jint,
    // 5: DetachCurrentThread
    pub detach_current_thread: unsafe extern "system" fn(vm: *mut JavaVM) -> jint,
    // 6: GetEnv
    pub get_env: unsafe extern "system" fn(vm: *mut JavaVM, penv: *mut *mut c_void, version: jint) -> jint,
}

/// nativeStart 时保存的 JavaVM（agent 线程回调 Java 用）
static JAVA_VM: AtomicPtr<JavaVM> = AtomicPtr::new(std::ptr::null_mut());

/// AgentBridge 类的全局引用——nativeStart（Java 线程，app classloader）时缓存。
/// 工具线程 FindClass 会用 bootstrap classloader 找不到应用类（经典坑）→ 必须全局引用。
static AGENT_BRIDGE_CLASS_REF: AtomicPtr<_jobject> = AtomicPtr::new(std::ptr::null_mut());

// ---------- logcat（liblog） ----------

const ANDROID_LOG_INFO: c_int = 4;
const ANDROID_LOG_ERROR: c_int = 6;

extern "system" {
    fn __android_log_write(prio: c_int, tag: *const c_char, msg: *const c_char) -> c_int;
}

const LOG_TAG: &CStr = c"gca-agent";

/// logcat 输出（Android 上 logging.rs 经此转发）
pub fn logcat_write(prio: c_int, msg: &str) {
    let Ok(msg) = CString::new(msg) else { return };
    unsafe {
        __android_log_write(prio, LOG_TAG.as_ptr(), msg.as_ptr());
    }
}

pub fn logcat_info(msg: &str) {
    logcat_write(ANDROID_LOG_INFO, msg);
}

/// 文件日志（Android）：写 app 私有目录 files/gca-agent.log——MIUI 等 ROM
/// 屏蔽 logcat 应用日志时的诊断通道，adb pull /run-as 可读。
/// 路径经 GCA_DEVICE_NAME 推断不可靠，直接用已知包名路径 + env 覆盖。
pub fn dlog(msg: &str) {
    use std::io::Write;
    let dir = std::env::var("GCA_ANDROID_FILES_DIR")
        .unwrap_or_else(|_| "/data/user/0/com.gca.client/files".to_string());
    let p = std::path::Path::new(&dir).join("gca-agent.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{msg}");
    }
}

// ---------- JNI 工具 ----------

/// Java String → Rust String
unsafe fn jstring_to_string(env: *mut JNIEnv, s: jstring) -> String {
    if env.is_null() || s.is_null() {
        return String::new();
    }
    let funcs = (*env).functions;
    let utf = unsafe { ((*funcs).get_string_utf_chars)(env, s, std::ptr::null_mut()) };
    if utf.is_null() {
        return String::new();
    }
    let out = unsafe { CStr::from_ptr(utf) }.to_string_lossy().into_owned();
    unsafe { ((*funcs).release_string_utf_chars)(env, s, utf) };
    out
}

/// Rust String → Java String
unsafe fn string_to_jstring(env: *mut JNIEnv, s: &str) -> jstring {
    let Ok(cs) = CString::new(s) else { return std::ptr::null_mut() };
    unsafe { ((*(*env).functions).new_string_utf)(env, cs.as_ptr()) }
}

/// Java byte[] → Vec<u8>
unsafe fn byte_array_to_vec(env: *mut JNIEnv, arr: jobject) -> Vec<u8> {
    if env.is_null() || arr.is_null() {
        return Vec::new();
    }
    let funcs = (*env).functions;
    let len = unsafe { ((*funcs).get_array_length)(env, arr) };
    if len <= 0 {
        return Vec::new();
    }
    let elems = unsafe { ((*funcs).get_byte_array_elements)(env, arr, std::ptr::null_mut()) };
    if elems.is_null() {
        return Vec::new();
    }
    let out = unsafe { std::slice::from_raw_parts(elems as *const u8, len as usize) }.to_vec();
    unsafe { ((*funcs).release_byte_array_elements)(env, arr, elems, 0) };
    out
}

/// 在 agent 线程上临时 attach JVM 并执行 f（返回 None = 不可用）
pub fn with_java<R>(f: impl FnOnce(*mut JNIEnv) -> R) -> Option<R> {
    let vm = JAVA_VM.load(Ordering::Acquire);
    if vm.is_null() {
        dlog("with_java: JAVA_VM null");
        return None;
    }
    let mut env: *mut c_void = std::ptr::null_mut();
    let attached = unsafe { ((*(*vm).functions).get_env)(vm, &mut env, JNI_VERSION_1_6) };
    let detach_needed = attached != JNI_OK || env.is_null();
    if detach_needed {
        dlog("with_java: attaching thread");
        let rc = unsafe { ((*(*vm).functions).attach_current_thread)(vm, &mut env, std::ptr::null_mut()) };
        if rc != JNI_OK || env.is_null() {
            dlog(&format!("with_java: attach failed rc={rc}"));
            return None;
        }
    }
    let res = f(env as *mut JNIEnv);
    if detach_needed {
        unsafe {
            ((*(*vm).functions).detach_current_thread)(vm);
        }
        dlog("with_java: detached");
    }
    Some(res)
}

// ---------- Java 静态方法调用（AgentBridge.kt，P2 工具回调） ----------

const AGENT_BRIDGE_CLASS: &CStr = c"com/gca/client/AgentBridge";

/// FindClass + GetStaticMethodID（缓存 method id 避免每次查找？先不缓存——调用频率低）
unsafe fn static_method(env: *mut JNIEnv, name: &CStr, sig: &CStr) -> Option<(jclass, *mut c_void)> {
    // 用 nativeStart 缓存的全局类引用——工具线程 FindClass 会落到 bootstrap
    // classloader 找不到应用类（经典坑）；方法查找失败时清悬挂异常防污染
    let cls = AGENT_BRIDGE_CLASS_REF.load(Ordering::Acquire);
    if env.is_null() || cls.is_null() {
        return None;
    }
    let funcs = (*env).functions;
    let mid = unsafe { ((*funcs).get_static_method_id)(env, cls, name.as_ptr(), sig.as_ptr()) };
    if mid.is_null() {
        unsafe { ((*funcs).exception_clear)(env) };
        return None;
    }
    Some((cls, mid))
}

/// 剪贴板读取（AgentBridge.getClipboard() → String）
pub fn android_get_clipboard() -> Option<String> {
    with_java(|env| unsafe {
        let (cls, mid) = static_method(env, c"getClipboard", c"()Ljava/lang/String;")?;
        let s = ((*(*env).functions).call_static_object_method)(env, cls, mid);
        Some(jstring_to_string(env, s))
    })
    .flatten()
}

/// 剪贴板写入（AgentBridge.setClipboard(String)）
pub fn android_set_clipboard(text: &str) -> bool {
    with_java(|env| unsafe {
        let (cls, mid) = static_method(env, c"setClipboard", c"(Ljava/lang/String;)V")?;
        let js = string_to_jstring(env, text);
        if js.is_null() {
            return Some(false);
        }
        ((*(*env).functions).call_static_void_method)(env, cls, mid, js);
        // Java 侧异常（如 SecurityException）→ 清悬挂并报失败
        if unsafe { ((*(*env).functions).exception_check)(env) } != 0 {
            unsafe { ((*(*env).functions).exception_clear)(env) };
            return Some(false);
        }
        Some(true)
    })
    .flatten()
    .unwrap_or(false)
}

/// 截图（AgentBridge.takeScreenshot() → byte[] JPEG；同步阻塞等待 A11y 回调）
pub fn android_take_screenshot() -> Option<Vec<u8>> {
    with_java(|env| unsafe {
        let (cls, mid) = static_method(env, c"takeScreenshot", c"()[B")?;
        let arr = ((*(*env).functions).call_static_object_method)(env, cls, mid);
        Some(byte_array_to_vec(env, arr))
    })
    .flatten()
    .filter(|v| !v.is_empty())
}

/// 通知（AgentBridge.sendNotification(String, String)）
pub fn android_notify(title: &str, message: &str) -> bool {
    let r = with_java(|env| unsafe {
        dlog("notify: in with_java");
        let (cls, mid) = static_method(env, c"sendNotification", c"(Ljava/lang/String;Ljava/lang/String;)V")?;
        dlog("notify: method id ok");
        let jt = string_to_jstring(env, title);
        let jm = string_to_jstring(env, message);
        if jt.is_null() || jm.is_null() {
            dlog("notify: jstring null");
            return Some(false);
        }
        dlog("notify: calling java");
        ((*(*env).functions).call_static_void_method)(env, cls, mid, jt, jm);
        dlog("notify: java returned");
        if unsafe { ((*(*env).functions).exception_check)(env) } != 0 {
            dlog("notify: java exception pending, clearing");
            unsafe { ((*(*env).functions).exception_clear)(env) };
            return Some(false);
        }
        Some(true)
    })
    .flatten()
    .unwrap_or(false);
    dlog(&format!("notify: result={r}"));
    r
}

/// 远程输入（AgentBridge.inputDispatch(type, x, y, text) → boolean）
pub fn android_remote_input(kind: &str, x: i32, y: i32, text: &str) -> Option<String> {
    with_java(|env| unsafe {
        let (cls, mid) = static_method(env, c"inputDispatch", c"(Ljava/lang/String;IILjava/lang/String;)Z")?;
        let jk = string_to_jstring(env, kind);
        let jt = string_to_jstring(env, text);
        if jk.is_null() || jt.is_null() {
            return Some(("ERR_JNI_STR".to_string(),));
        }
        let ok = ((*(*env).functions).call_static_boolean_method)(env, cls, mid, jk, x, y, jt);
        Some(((if ok != 0 { "ok" } else { "failed" }).to_string(),))
    })
    .flatten()
    .map(|r| r.0)
}

// ---------- native 方法（Kotlin: NativeBridge.nativeStart） ----------

/// 启动 agent 服务线程。参数经 set_var 注入（Android 无自定义进程 env），
/// 服务逻辑与 gca-agent bin 完全一致（agent_server::serve）。
/// P3：token = S1 设备自铸 token（Kotlin 生成持久化）；machine_id = 设备身份
/// （Build 指纹等）；审计推送 Android 默认开（无人值守设备）。
#[no_mangle]
pub unsafe extern "system" fn Java_com_gca_client_NativeBridge_nativeStart(
    env: *mut JNIEnv,
    _cls: jclass,
    port: jint,
    token: jstring,
    device_name: jstring,
    server_url: jstring,
    machine_id: jstring,
) -> jint {
    let port = if port <= 0 { 3003 } else { port as u16 };
    let token = unsafe { jstring_to_string(env, token) };
    let device_name = unsafe { jstring_to_string(env, device_name) };
    let server_url = unsafe { jstring_to_string(env, server_url) };
    let machine_id = unsafe { jstring_to_string(env, machine_id) };

    logcat_info(&format!(
        "nativeStart: port={port} device={device_name} server={server_url} machine={machine_id} token={}",
        if token.is_empty() { "(open mode!)" } else { "configured" }
    ));

    // 保存 JavaVM + AgentBridge 全局类引用（P2 工具回调 Java 用）。
    // 本函数在 Java 线程执行（app classloader）——FindClass 必须在此缓存：
    // 工具线程（attach 后）FindClass 会落到 bootstrap classloader 找不到应用类。
    if !env.is_null() {
        let funcs = (*env).functions;
        let mut vm: *mut JavaVM = std::ptr::null_mut();
        let rc = unsafe { ((*funcs).get_java_vm)(env, &mut vm) };
        if rc == JNI_OK && !vm.is_null() {
            JAVA_VM.store(vm, Ordering::Release);
        }
        let cls = unsafe { ((*funcs).find_class)(env, AGENT_BRIDGE_CLASS.as_ptr()) };
        if !cls.is_null() {
            let g = unsafe { ((*funcs).new_global_ref)(env, cls) };
            if !g.is_null() {
                AGENT_BRIDGE_CLASS_REF.store(g as *mut _jobject, Ordering::Release);
                logcat_info("AgentBridge global class ref cached");
            }
        } else {
            unsafe { ((*funcs).exception_clear)(env) };
            logcat_write(ANDROID_LOG_ERROR, "AgentBridge class not found (FindClass failed)");
        }
    }

    // Android 无自定义进程 env（Zygote 固定）→ 进程内存注入，config.rs 零改动
    std::env::set_var("GCA_AGENT_PORT", port.to_string());
    std::env::set_var("GCA_MCP_TOKEN", &token);
    std::env::set_var("GCA_DEVICE_TOKEN", &token); // S1：设备自铸 token（P3）
    std::env::set_var("GCA_DEVICE_NAME", &device_name);
    std::env::set_var("GCA_MACHINE_ID", &machine_id);
    std::env::set_var("GCA_SERVER_URL", &server_url);
    // P3：Android 为无人值守设备，审计推送默认开（本地留痕退居次位）
    std::env::set_var("GCA_AUDIT_PUSH", "1");

    // panic hook：Android 上 stdout/stderr 不进 logcat——panic 转 dlog + logcat
    // （正式版诊断价值：agent 线程 panic 可现场定位）
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {info}");
        dlog(&msg);
        logcat_write(ANDROID_LOG_ERROR, &msg);
        let loc = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let loc_msg = format!("PANIC location:{loc}");
        dlog(&loc_msg);
        logcat_write(ANDROID_LOG_ERROR, &loc_msg);
    }));

    // agent 线程：纯 Rust 网络，需要 Java 回调时 with_java 临时 attach
    std::thread::Builder::new()
        .name("gca-agent".to_string())
        .spawn(move || {
            let cfg = config::load();
            if let Err(e) = agent_server::serve(&cfg) {
                logcat_write(ANDROID_LOG_ERROR, &format!("agent server error: {e}"));
            }
        })
        .ok();

    0
}
