package com.gca.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.core.app.NotificationCompat

/**
 * AgentBridge — Rust agent（libgca_agent.so）经 JNI 回调的系统能力桥。
 * Android 原生化 P2（docs/android-native-plan.md）：agent 工具线程 with_java
 * attach 后调用本 object 的静态方法。所有方法可在任意线程调用（系统服务
 * 为 Binder 代理；A11y 手势经主线程 Handler post）。
 */
object AgentBridge {
    private const val TAG = "GCA-Bridge"
    private const val NOTIFY_CHANNEL = "gca-notify"

    private var appContext: Context? = null

    /** 由 GcaService.onCreate 注入（applicationContext，跨线程安全） */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    // ---------- 剪贴板 ----------

    @JvmStatic
    fun getClipboard(): String? {
        val ctx = appContext ?: return null
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
        return try {
            cm.primaryClip?.getItemAt(0)?.text?.toString()
        } catch (e: Exception) {
            Log.e(TAG, "getClipboard failed", e)
            null
        }
    }

    @JvmStatic
    fun setClipboard(text: String) {
        val ctx = appContext ?: return
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        cm.setPrimaryClip(ClipData.newPlainText("gca", text))
    }

    // ---------- 截图（高低版本分支：API 30+ A11y takeScreenshot / API 26-29 MediaProjection） ----------

    @JvmStatic
    fun takeScreenshot(): ByteArray? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 高版本：A11y takeScreenshot（无需授权弹窗，一次开启无障碍即可）
            val a11y = GcaAccessibilityService.instance ?: run {
                Log.e(TAG, "AccessibilityService not enabled")
                return null
            }
            return a11y.captureToBytes()
        }
        // 低版本（API 26-29）：MediaProjection 虚拟显示抓帧（MainActivity 授权流）
        val svc = GcaService.agentInstance() ?: return null
        return svc.captureFrameFromProjection()
    }

    // ---------- 通知 ----------

    @JvmStatic
    fun sendNotification(title: String, message: String) {
        val ctx = appContext ?: return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(NOTIFY_CHANNEL, "GCA Notify", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val notification = NotificationCompat.Builder(ctx, NOTIFY_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(message)
            .setAutoCancel(true)
            .build()
        nm.notify(System.currentTimeMillis().toInt(), notification)
    }

    // ---------- 远程输入（A11y 手势 + 焦点文本框文本注入） ----------

    @JvmStatic
    fun inputDispatch(kind: String, x: Int, y: Int, text: String): Boolean {
        val a11y = GcaAccessibilityService.instance ?: return false
        return when (kind) {
            "tap" -> a11y.gestureTap(x, y)
            "swipe" -> a11y.gestureSwipe(x, y)
            "scroll" -> a11y.gestureScroll(x, y)
            "type" -> a11y.inputText(text) // A11y ACTION_SET_TEXT 注入焦点文本框
            else -> false
        }
    }
}
