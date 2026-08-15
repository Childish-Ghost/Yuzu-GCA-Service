package com.gca.client

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.accessibilityservice.GestureDescription.StrokeDescription
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Accessibility service for screen capture (Android 11+ takeScreenshot).
 *
 * Enable once in Settings → Accessibility → GCA Screen Capture.
 * After that, screenshots work without any permission dialogs.
 *
 * Communication: JNI bridge（Android 原生化 P2 起）——Rust agent 经
 *   takeScreenshot() 回调截图；nodejs-mobile 文件轮询协议已随 P1 移除。
 */
class GcaAccessibilityService : AccessibilityService() {

    companion object {
        const val TAG = "GCA-A11y"
        @Volatile
        var instance: GcaAccessibilityService? = null
            private set
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "Accessibility service connected")

        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            notificationTimeout = 100
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Required for takeScreenshot() to work on Android 11+
                flags = flags or AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
            }
        }
        serviceInfo = info
        Log.i(TAG, "Service info set, canTakeScreenshot=${Build.VERSION.SDK_INT >= Build.VERSION_CODES.R}")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // No-op: we only use takeScreenshot(), not event observation
    }

    override fun onInterrupt() {
        Log.i(TAG, "Accessibility service interrupted")
    }

    override fun onDestroy() {
        instance = null
        executor.shutdown()
        super.onDestroy()
    }

    /**
     * Takes a screenshot via the accessibility API (Android 11+).
     * Saves PNG to the given path, then calls onComplete.
     */
    fun captureScreen(resultPath: String, onComplete: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.e(TAG, "takeScreenshot requires Android 11+")
            onComplete(false)
            return
        }

        Log.i(TAG, "Taking screenshot via AccessibilityService...")
        takeScreenshot(
                0, // DEFAULT_DISPLAY — display property throws in non-visual context
                executor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val hb = screenshot.hardwareBuffer
                    val colorSpace = screenshot.colorSpace
                    Log.i(TAG, "Screenshot captured: ${hb.width}x${hb.height} format=${hb.format}")
                    try {
                        // Try wrapHardwareBuffer first (most efficient, works on most devices)
                        var bitmap = Bitmap.wrapHardwareBuffer(hb, colorSpace)

                        if (bitmap == null) {
                            // Fallback: try with null colorSpace
                            Log.w(TAG, "wrapHardwareBuffer with colorSpace failed, trying null colorSpace")
                            bitmap = Bitmap.wrapHardwareBuffer(hb, null as ColorSpace?)
                        }

                        if (bitmap == null) {
                            Log.e(TAG, "wrapHardwareBuffer returned null — hardware buffer format not supported by Bitmap")
                            hb.close()
                            val errFile = File(resultPath.replace(".png", ".error"))
                            errFile.writeText("wrapHardwareBuffer failed: device uses unsupported HardwareBuffer format (${hb.format})")
                            onComplete(false)
                            return
                        }

                        val file = File(resultPath)
                        file.parentFile?.mkdirs()
                        FileOutputStream(file).use { out ->
                            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                        }
                        Log.i(TAG, "Screenshot saved: ${file.absolutePath} (${file.length()} bytes)")
                        bitmap.recycle()
                        hb.close()
                        onComplete(true)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to save screenshot", e)
                        try { hb.close() } catch (_: Exception) {}
                        val errFile = File(resultPath.replace(".png", ".error"))
                        errFile.writeText("Screenshot save error: ${e.message}")
                        onComplete(false)
                    }
                }

                override fun onFailure(errorCode: Int) {
                    val reason = when (errorCode) {
                        1 -> "INTERNAL_ERROR"
                        3 -> "INTERVAL_TIME_SHORT"
                        4 -> "INVALID_DISPLAY"
                        5 -> "NO_ACCESSIBILITY_ACCESS"
                        6 -> "SECURE_WINDOW"
                        else -> "UNKNOWN($errorCode)"
                    }
                    Log.e(TAG, "takeScreenshot failed: $reason (code=$errorCode)")
                    val errFile = File(resultPath.replace(".png", ".error"))
                    errFile.writeText("A11y takeScreenshot failed: $reason (code=$errorCode)")
                    onComplete(false)
                }
            }
        )
    }

    /**
     * Takes a screenshot and returns JPEG bytes (synchronous — blocks until
     * the A11y callback fires or 10s timeout). Android 原生化 P2：Rust agent
     * 经 AgentBridge.takeScreenshot() 调用。
     */
    fun captureToBytes(): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val latch = CountDownLatch(1)
        var result: ByteArray? = null
        val out = ByteArrayOutputStream()
        takeScreenshot(
            0, executor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    try {
                        val hb = screenshot.hardwareBuffer
                        val cs = screenshot.colorSpace
                        var bmp = Bitmap.wrapHardwareBuffer(hb, cs)
                        if (bmp == null) bmp = Bitmap.wrapHardwareBuffer(hb, null as ColorSpace?)
                        if (bmp == null) {
                            Log.e(TAG, "wrapHardwareBuffer failed")
                        } else {
                            bmp.compress(Bitmap.CompressFormat.JPEG, 70, out)
                            result = out.toByteArray()
                            bmp.recycle()
                        }
                        hb.close()
                    } catch (e: Exception) {
                        Log.e(TAG, "captureToBytes error", e)
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Log.e(TAG, "takeScreenshot failed: code=$errorCode")
                    latch.countDown()
                }
            }
        )
        return try {
            latch.await(10, TimeUnit.SECONDS)
            result
        } catch (e: InterruptedException) {
            null
        }
    }

    // ---------- 手势（Android 原生化 P2：remote_input JNI 回调） ----------

    /** 点击 (x, y) */
    fun gestureTap(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = StrokeDescription(path, 0, 60)
        return dispatchGestureBlocking(GestureDescription.Builder().addStroke(stroke).build())
    }

    /** 从 (0,0) 滑到 (x, y)（mouse_move 映射） */
    fun gestureSwipe(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(0f, 0f); lineTo(x.toFloat(), y.toFloat()) }
        val stroke = StrokeDescription(path, 0, 200)
        return dispatchGestureBlocking(GestureDescription.Builder().addStroke(stroke).build())
    }

    /** 从 (x, y) 向上滑动（scroll down 映射） */
    fun gestureScroll(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()); lineTo(x.toFloat(), (y - 300).coerceAtLeast(0).toFloat()) }
        val stroke = StrokeDescription(path, 0, 200)
        return dispatchGestureBlocking(GestureDescription.Builder().addStroke(stroke).build())
    }

    /**
     * 文本注入（key_type）：对焦点文本框执行 ACTION_SET_TEXT（无障碍标准方案，
     * 无需 IME 权限）。焦点节点缺失时 fallback 到活动窗口首个可编辑节点。
     * 必须在主线程执行（AccessibilityService 窗口 API 线程绑定——agent 线程
     * 调用会拿到 null root）；同步等待结果（3s 超时）。
     */
    fun inputText(text: String): Boolean {
        val done = CountDownLatch(1)
        val result = booleanArrayOf(false)
        mainHandler.post {
            // A11y 刚连接/窗口切换时 root 可能未就绪——短暂重试（1.5s 窗口）
            var root = rootInActiveWindow
            var tries = 0
            while (root == null && tries < 3) {
                try { Thread.sleep(500) } catch (_: InterruptedException) { break }
                root = rootInActiveWindow
                tries++
            }
            if (root == null) {
                Log.e(TAG, "inputText: rootInActiveWindow null after retries")
                done.countDown()
                return@post
            }
            // 活动窗口树：焦点节点（须可编辑，Chrome 等焦点容器不可编辑时放弃）
            // → fallback 首个可编辑节点 → 遍历所有窗口（输入框可能在独立
            // accessibility window）
            var target = findFocusedNode(root)
            if (target != null && !isEditableNode(target)) target = null
            if (target == null) target = findFirstEditable(root)
            if (target == null) {
                for (w in windows) {
                    val wroot = w.root ?: continue
                    target = findFirstEditable(wroot)
                    if (target != null) break
                }
            }
            if (target == null) {
                Log.e(TAG, "inputText: no editable node found (root children=${root.childCount})")
                done.countDown()
                return@post
            }
            // 可编辑判断放宽：Chrome 等自定义 EditText 节点 isEditable 可能为 false
            val cls = target.className?.toString() ?: ""
            val editable = isEditableNode(target)
            if (!editable) {
                Log.e(TAG, "inputText: target not editable (cls=$cls)")
                done.countDown()
                return@post
            }
            // 先尝试 focus（部分自定义输入框需要焦点后才接受 SET_TEXT）
            if (!target.isFocused) {
                target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            }
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            result[0] = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            Log.i(TAG, "inputText: performAction SET_TEXT -> ${result[0]} (cls=$cls)")
            done.countDown()
        }
        return try {
            done.await(5, TimeUnit.SECONDS)
            result[0]
        } catch (e: InterruptedException) {
            false
        }
    }

    private fun findFocusedNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findFocusedNode(child)
            if (found != null) return found
        }
        return null
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (isEditableNode(node)) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findFirstEditable(child)
            if (found != null) return found
        }
        return null
    }

    /** 可编辑判断放宽：isEditable 或 className 含 EditText（Chrome 等自定义输入框） */
    private fun isEditableNode(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable) return true
        val cls = node.className?.toString() ?: return false
        return cls.contains("EditText")
    }

    /** dispatchGesture（主线程）+ 同步等待结果（3s 超时） */
    private fun dispatchGestureBlocking(gesture: GestureDescription): Boolean {
        val done = CountDownLatch(1)
        val result = booleanArrayOf(false)
        mainHandler.post {
            result[0] = dispatchGesture(gesture, object : GestureResultCallback() {
                override fun onCompleted(g: GestureDescription?) { done.countDown() }
                override fun onCancelled(g: GestureDescription?) { done.countDown() }
            }, null)
            if (!result[0]) done.countDown()
        }
        return try {
            done.await(3, TimeUnit.SECONDS)
            result[0]
        } catch (e: InterruptedException) {
            false
        }
    }
}