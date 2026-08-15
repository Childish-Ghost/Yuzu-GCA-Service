//! agent 构建脚本——Android target 链接 liblog（logcat 输出，jni_bridge 用）。

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=log");
    }
}
