# Android 原生化计划（Rust NDK + JNI，nodejs-mobile 退出）

> 2026-08-13 制定 · P1 主线 · 依赖：GCA-MASTER 决策 11（双版本模型）/ S1 设备 token / INT-004/005
> 目标：Android APK 从 nodejs-mobile（13/20 工具、C1/S1 遗留）迁移到 Rust agent（0.2.0 全链路），
> 事件驱动阶段二 Android 子项、mDNS/审计接入随重写一并落地。

## 一、现状资产（复用清单）

| 资产 | 现状 | 原生化复用 |
|------|------|-----------|
| agent lib（Rust） | 零依赖（仅 serde_json），HTTP 手写 std TCP，audit/pending/tickets/approval 跨平台纯逻辑 | **直接编译**，仅需 Windows 模块 cfg 隔离 |
| ps.rs / exec.rs | 已有 `#[cfg(target_os="windows")]` 分支意识 | 扩展为 Android 分支 |
| gca-native.cpp | nodejs-mobile embed 壳 | ✅ 已删（P1，含 include/node/） |
| NativeBridge.kt | JNI 桥（现桥 node） | 改造为桥 Rust（启动线程 + 注入 env + 回调） |
| GcaService.kt | 前台服务（保活） | 复用 |
| BootReceiver.kt | 开机自启 | 复用 |
| GcaAccessibilityService.kt | 无障碍服务（remote_input 基础） | 复用（JNI 回调） |
| MainActivity.kt | 界面/服务启动 | 复用（静态状态页 + startForegroundService） |
| NDK 27.1 + abiFilters arm64-v8a/x86_64 | 已配 | 复用 |

## 二、方案

- **构建**：gradle `externalNativeBuild` + CMakeLists 调 `cargo build --target <abi>`（cargo-ndk），产物 `libgca_agent.so` 入 APK；**删除** nodejs-mobile embed（cpp/include/node、assets/gca-bundle.cjs、esbuild 打包链）
- **进程模型**：Java 侧 JNI 启动 Rust agent 线程（std::thread），TCP 监听沿用 3001 逻辑（GCA_AGENT_PORT 可配）；前台服务保活 + 开机自启不变
- **配置注入**：assets/gca-token.txt → SharedPreferences 迁移；S1 设备 token 铸造/存储（Android Keystore 或文件 0600）
- **工具层**：与 node 版 13/20 对齐的取舍（见下），JNI 回调 Kotlin 侧能力（剪贴板/截图/无障碍/通知）
- **版本**：gradle versionName 0.1.0→**0.2.0**、versionCode 1→2（MINOR 新功能，agent 组件线已 0.2.0 同步）；产物 `gca-agent-android-B0.2.0.apk`（§3 单组件命名）

## 三、阶段排期（按 2026-08-05~13 开发节奏，一天 1-2 里程碑）

| 阶段 | 内容 | 估时 | 交付物 |
|------|------|------|--------|
| **P0 构建链与编译隔离** ✅ 2026-08-13 | **NDK clang 直连（无 cargo-ndk）**：rustup Android target + CARGO_TARGET_*_LINUX_ANDROID_LINKER 环境变量（build-rust-native.cmd 固化）；lib 层 cfg 隔离（conpty/term 仅 windows + gca-term bin 占位 + ps/exec 超时杀进程 POSIX 分支）；cdylib crate-type | 0.5-1 天（实 2h） | ✅ 双 ABI check+build 过，libgca_agent.so（release 344KB）入 jniLibs，gradle assembleDebug 成功，56 测试全绿 |
| **P1 JNI 桥与进程模型** ✅ 2026-08-13 | NativeBridge 改桥 Rust：手写 JNI FFI（jni_bridge.rs，零依赖）+ set_var 注入（Android 无自定义进程 env）+ logcat 桥；nodejs-mobile 壳整体退出（cpp/libnode.so/bundle/esbuild 链删除，APK 164MB→5.2MB）；前台服务/自启复用 | 1 天（实 2h） | ✅ 真机 /mcp initialize 返回 gca-agent 0.2.0（20 工具）、无 Bearer 401、VM 代理链路通、设备名复用（覆盖安装保留 filesDir） |
| **P2 工具层 Android 适配** ✅ 2026-08-13 | exec 改 /system/bin/sh；**双向 JNI 桥**（JavaVM attach + AgentBridge.kt 静态方法 + 全局类引用缓存防 classloader 坑）；clipboard→ClipboardManager（读受限 Android 10+ 有提示）；screenshot→A11y takeScreenshot；remote_input→dispatchGesture（tap/swipe/scroll）；notify→NotificationManager；power/service/consent unsupported；**高低版本分支**（API 30+ A11y / 26-29 MediaProjection 授权流 / startForegroundService+Notification.Builder API 26+ 分支 / minSdk 24）；base64 抽公共模块；x86 ABI（i686 target）供 Android 7 模拟器 | 1.5-2 天（实 3h） | ✅ **双模拟器 + 真机全验证**：API 36（A11y 截图 49KB）+ API 24 Android 7（MediaProjection 截图 44KB，exec/notify 同通）+ 真机；minSdk 26→24 |
| **P3 认证/事件/审计对齐** ✅ 2026-08-13 | S1 设备 token（Kotlin SecureRandom 铸造 + SharedPreferences 持久化，替代 assets owner token 遗留——授权坍缩修复）；Rust 心跳线程（agent_server::start_heartbeat，登录立即+每 5 分钟，设备 token 认证，URL/machineId 上报）；注册携 deviceToken+machineId；审计 Android 默认开（GCA_AUDIT_PUSH=1）；panic hook（dlog+logcat，stdout/stderr 不进 logcat）；cleartext 放行（内网部署）；发现 **BOOT_COMPLETED FGS 限制**（Android 15+ dataSync 禁启，待修） | 0.5-1 天（实 2h） | ✅ 端到端：注册→审批（551351）→心跳 URL 上报（<本机IP>:3003+machineId）→ exec 审计落地 VM（`exec|executed`）；MCP 认证切设备 token |
| **P4 回归与发布** ✅ 2026-08-13 | 三环境回归（API 36 模拟器 / API 24 A7 / 真机 MIUI）；versionName 0.2.0/versionCode 2；release 签名（新建 gca-release.jks，keystore 不入库）；命名 `gca-agent-android-B0.2.0.apk` | 0.5-1 天（实 2h） | ✅ 产物就绪；**真机 MIUI 全链路补验完成（2026-08-14）**：注册（同 machineId 直批）/心跳/审计/exec/notify/截图（85KB）/key_type（GCA_MIUI_TEST 注入成功）/锁屏 5 分钟保活——全通 |
| **合计** | | **4-6 天** | |

## 四、工具取舍（与 node 版 13/20 对齐）

| 工具 | Android 实现 | 说明 |
|------|-------------|------|
| exec / exec_background | /system/bin/sh | 去 cmd /C + chcp 前缀 |
| file_read/write/move/delete/serve/fetch | scoped storage 路径 | /sdcard 可写区 |
| clipboard_sync | JNI → ClipboardManager | |
| screenshot | A11y takeScreenshot + JNI | GcaAccessibilityService.captureScreen 已有实现（非 MediaProjection——ScreenCaptureActivity 已删） |
| remote_input | JNI → GcaAccessibilityService | 复用现成 .kt |
| screen_consent / input_consent | Kotlin 原生对话框 | |
| notify_send | JNI → NotificationManager | |
| power / service | unsupported | 与 node 版一致 |
| confirm / pending / approval / tickets / audit | 纯逻辑直接可用 | 含审计挂钩四类事件 |

## 五、风险与挂起条件

1. **真机授权交互**（无障碍开启——截图/远程输入依赖）需用户真机操作——P2 中段可能需要你配合操作 gca-2312CRAD3C
2. **scoped storage** 路径语义与 Windows 差异大，file 工具回归要真机验证
3. 后台进程保活：Android 12+ 限制（前台服务已解决基础；锁屏 5 分钟实测存活）；**MIUI 的 A11y 需设置界面手动开启**（adb settings put 写入但不绑定——MIUI 安全设计；开启后截图/key_type 实测通过）
4. node 版 13 工具行为对齐：以 client/src 现有 handler 的 Android 分支为基准实现

## 六、完成定义

- [x] `cargo test` 通过 + Android target 编译通过（agent lib 无 Windows 泄漏）
- [x] APK 装机：/mcp initialize、注册审批、exec、screenshot、clipboard、remote_input、audit 端到端（P2 验证 2026-08-13）
- [ ] 面板四态显示 Android 设备在线（心跳 + URL 正确）——P3
- [ ] versionName 0.2.0 / versionCode 2，APK 命名 `gca-agent-android-B0.2.0.apk`——P4
- [ ] 文档落盘：MASTER 待办勾选、api.md/architecture.md Android 章节更新、Release 挂包——P4

## P2 调试踩坑记录（2026-08-13，模拟器定位）

1. **FindClass classloader 坑**：native 线程 attach 后 FindClass 落 bootstrap classloader 找不到应用类 → 异常悬挂 → 后续 JNI 调用崩溃 → 修复：nativeStart（Java 线程）FindClass + NewGlobalRef 缓存全局引用
2. **JavaVM 结构**：Android ART 无 reserved 字段（functions 在偏移 0，HotSpot 有 reserved0/1）——结构不符 → null+0x30 崩溃
3. **JNI 索引必须从 NDK jni.h 数**：ExceptionCheck 真实索引 228（201 是 GetCharArrayRegion）——错位会被 CheckJNI 拦截 abort（debuggable app 开启参数校验，正好当校验器用）
4. **MIUI logcat 屏蔽**：真机不可见 app 日志 → 模拟器验证 + Rust 侧文件日志（dlog，run-as 可读）
5. **A11y 服务 force-stop 后需重新 toggle**（settings put 空→再启用）

## 七、不做的事（边界）

- ❌ Android 上跑 gca-term（ConPTY 是 Windows 硬依赖；人终端 Android 侧不在本计划）
- ❌ 无障碍/截图授权流的自动绕过（保持系统安全交互）
- ❌ x86 模拟器优化（只保 arm64-v8a 正式 + x86_64 调试）
