@echo off
REM build-rust-native.cmd — Android 原生化：编译 Rust agent 为 libgca_agent.so 并入 jniLibs
REM Source: agent/（Rust 设备端，零依赖）
REM 用 Android Studio 的 NDK clang 直连（无需 cargo-ndk），docs/android-native-plan.md P0
REM Run from project root (D:\Yuzu-GCA-Service) or android/
cd /d "%~dp0\.."

set NDK_BIN=%LOCALAPPDATA%\Android\Sdk\ndk\27.1.12297006\toolchains\llvm\prebuilt\windows-x86_64\bin
if not exist "%NDK_BIN%\aarch64-linux-android21-clang.cmd" (
    echo ERROR: NDK clang not found at %NDK_BIN%
    exit /b 1
)

echo [1/2] Building libgca_agent.so (release, arm64-v8a + x86_64)...
set CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=%NDK_BIN%\aarch64-linux-android21-clang.cmd
set CARGO_TARGET_AARCH64_LINUX_ANDROID_AR=%NDK_BIN%\llvm-ar.exe
set CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=%NDK_BIN%\x86_64-linux-android21-clang.cmd
set CARGO_TARGET_X86_64_LINUX_ANDROID_AR=%NDK_BIN%\llvm-ar.exe

cd agent
call cargo build --release --target aarch64-linux-android --lib
if %ERRORLEVEL% neq 0 ( echo ERROR: arm64 build failed & exit /b 1 )
call cargo build --release --target x86_64-linux-android --lib
if %ERRORLEVEL% neq 0 ( echo ERROR: x86_64 build failed & exit /b 1 )
cd ..

echo [2/2] Installing to jniLibs...
if not exist "android\app\src\main\jniLibs\arm64-v8a" mkdir "android\app\src\main\jniLibs\arm64-v8a"
if not exist "android\app\src\main\jniLibs\x86_64" mkdir "android\app\src\main\jniLibs\x86_64"
copy /y "target\aarch64-linux-android\release\libgca_agent.so" "android\app\src\main\jniLibs\arm64-v8a\" >nul
copy /y "target\x86_64-linux-android\release\libgca_agent.so" "android\app\src\main\jniLibs\x86_64\" >nul

echo DONE: libgca_agent.so installed in jniLibs
echo Now run: cd android ^&^& gradlew assembleDebug
