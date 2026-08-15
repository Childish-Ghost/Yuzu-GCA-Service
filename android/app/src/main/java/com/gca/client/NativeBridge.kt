package com.gca.client

/**
 * JNI bridge to the Rust agent (libgca_agent.so) — Android 原生化（docs/android-native-plan.md P1）。
 * Loads the Rust library and exposes the start function.
 *
 * Note: Android 无自定义进程 env（Zygote 固定）——token/port/deviceName 以参数传入，
 * Rust 侧 set_var 注入后走与 gca-agent bin 完全一致的 config.rs。
 */
object NativeBridge {
    init {
        // Rust agent（手写 JNI FFI，零依赖；nodejs-mobile 已退出）
        System.loadLibrary("gca_agent")
    }

    /**
     * Starts the Rust agent MCP server on a background thread.
     * Non-blocking — spawns the server thread inside native code and returns.
     * P3：token = S1 设备自铸 token；machineId = 设备身份（注册/心跳用）。
     */
    @JvmStatic
    external fun nativeStart(port: Int, token: String, deviceName: String, serverUrl: String, machineId: String): Int
}
