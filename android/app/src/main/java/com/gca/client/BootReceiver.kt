package com.gca.client

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Receives BOOT_COMPLETED / USER_PRESENT broadcasts and starts GcaService.
 *
 * Android 15+ 限制：BOOT_COMPLETED 广播上下文内不允许启动非豁免类型的
 * 前台服务（dataSync 被拒，ForegroundServiceStartNotAllowedException）——
 * 修复：延迟启动（离开广播上下文）+ 等待用户解锁（USER_PRESENT 或轮询
 * KeyguardManager）。
 * On Xiaomi/Chinese ROMs, user must also enable "Autostart" in phone settings.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> {
                Log.i(GcaService.TAG, "Boot completed, scheduling GCA service start (delay for Android 15 FGS rule)...")
                scheduleStart(context, 0)
            }
            Intent.ACTION_USER_PRESENT -> {
                // 接收器上下文内立即启动（Android 12+ 豁免 USER_PRESENT 场景）
                Log.i(GcaService.TAG, "User unlocked, starting GCA service...")
                startService(context)
            }
        }
    }

    /** 延迟启动：等系统就绪 + 用户解锁（Android 15+ BOOT_COMPLETED FGS 限制） */
    private fun scheduleStart(context: Context, attempt: Int) {
        if (attempt >= MAX_ATTEMPTS) return
        Handler(Looper.getMainLooper()).postDelayed({
            val kg = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            val locked = kg?.isKeyguardLocked == true
            if (locked) {
                // 设备未解锁——再等（USER_PRESENT 会兜底触发）
                Log.i(GcaService.TAG, "Device locked, retry in ${RETRY_MS / 1000}s (attempt ${attempt + 1})")
                scheduleStart(context, attempt + 1)
            } else {
                startService(context)
            }
        }, if (attempt == 0) BOOT_DELAY_MS else RETRY_MS)
    }

    private fun startService(context: Context) {
        Log.i(GcaService.TAG, "Starting GCA service...")
        val serviceIntent = Intent(context, GcaService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent) // API 24-25（Android 7 低版本）
        }
    }

    companion object {
        /** BOOT_COMPLETED 后首次延迟（避开广播上下文 + 系统未就绪期） */
        private const val BOOT_DELAY_MS = 15_000L
        private const val RETRY_MS = 10_000L
        private const val MAX_ATTEMPTS = 6
    }
}
