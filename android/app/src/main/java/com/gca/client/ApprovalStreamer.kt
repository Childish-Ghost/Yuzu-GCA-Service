package com.gca.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 审批下发流（2026-08-14，SSE 替代轮询）：GET /ops/events 长连接，
 * 收到 op.created → 弹审批通知（pendingIntent 直达 ApprovalActivity）；
 * 断线指数退避重连（1s→2s→4s...上限 60s）。由 GcaService 启动/停止。
 */
class ApprovalStreamer(private val context: Context) {

    companion object {
        private const val TAG = "GCA-Approval"
        const val CHANNEL_ID = "gca-approval"
        /** 已通知过的 op id（避免重连后 snapshot 重复通知） */
        private val notified = HashSet<String>()
        private const val MAX_BACKOFF_MS = 60_000L
    }

    @Volatile private var running = false
    private var thread: Thread? = null
    private var conn: HttpURLConnection? = null

    fun start() {
        if (running) return
        running = true
        ensureChannel()
        thread = Thread({ loop() }, "approval-streamer").apply { isDaemon = true }
        thread?.start()
    }

    // 审查 A-M4：stop 必须中断阻塞中的 reader（disconnect 使 readLine 抛异常退出）
    fun stop() {
        running = false
        try { conn?.disconnect() } catch (_: Exception) {}
    }

    private fun loop() {
        var backoff = 1_000L
        while (running) {
            try {
                val ok = streamOnce()
                if (ok) backoff = 1_000L else backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
            } catch (e: Exception) {
                Log.w(TAG, "stream error: ${e.message}")
                backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
            }
            if (!running) break
            try { Thread.sleep(backoff) } catch (_: InterruptedException) { break }
        }
    }

    /** 单次 SSE 连接：读到 EOF/异常返回 false（触发退避重连） */
    private fun streamOnce(): Boolean {
        val prefs = context.getSharedPreferences("gca", Context.MODE_PRIVATE)
        // 审查 A-M9：优先加密存储，兼容旧明文
        val token = OwnerCreds.getOwnerToken(context)
            ?: prefs.getString("owner_token_plain_fallback", "")
                ?: prefs.getString("owner_token", "").orEmpty()
        val server = prefs.getString("server_url", "http://<网关IP>:18790").orEmpty().trimEnd('/')
        if (token.isEmpty()) return false

        val conn = URL("$server/ops/events").openConnection() as HttpURLConnection
        this.conn = conn
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 10_000
        // 审查 A-H2：有限读超时（60s）——静默断连（NAT/Doze）由 SocketTimeoutException
        // 触发重连；无限阻塞会让审批通道静默死亡
        conn.readTimeout = 60_000
        val code = conn.responseCode
        if (code != 200) {
            conn.disconnect()
            return false
        }
        val reader = BufferedReader(InputStreamReader(conn.inputStream))
        var event: String? = null
        var data = StringBuilder()
        try {
            while (running) {
                val line = reader.readLine() ?: break
                if (line.startsWith("event: ")) {
                    event = line.substring(7)
                } else if (line.startsWith("data: ")) {
                    data.append(line.substring(6))
                } else if (line.isEmpty()) {
                    val payload = data.toString()
                    data = StringBuilder()
                    if (event != null && payload.isNotEmpty()) {
                        handleEvent(event!!, payload)
                    }
                    // 审查 A-L17：ready 事件后弹 snapshot summary（重启恢复待审批提醒）
                    if (event == "ready" && snapshotPendingCount > 0) {
                        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        val pi = PendingIntent.getActivity(context, -1, Intent(context, ApprovalActivity::class.java),
                            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                        val n = NotificationCompat.Builder(context, CHANNEL_ID)
                            .setSmallIcon(android.R.drawable.ic_dialog_info)
                            .setContentTitle("GCA 审批")
                            .setContentText("有 $snapshotPendingCount 条待审批请求")
                            .setContentIntent(pi)
                            .setAutoCancel(true)
                            .build()
                        nm.notify(-1, n)
                        snapshotPendingCount = 0
                    }
                    event = null
                }
            }
        } finally {
            reader.close()
            conn.disconnect()
        }
        return false // 正常 EOF → 重连
    }

    private fun handleEvent(event: String, payload: String) {
        try {
            val op = JSONObject(payload)
            val id = op.optString("id", "")
            val status = op.optString("status", "")
            when (event) {
                "op.created" -> {
                    if (synchronized(notified) { notified.add(id) }) {
                        notifyApproval(id, op.optString("device", "?"), op.optString("operation", "?"))
                    }
                }
                "op.resolved" -> {
                    synchronized(notified) { notified.remove(id) }
                    cancelNotification(id)
                }
                "op.snapshot" -> {
                    // 审查 A-L17：snapshot 只统计（重启后多条 pending 不逐条弹窗/通知风暴），
                    // 由 SSE 连接完成后的 summary 通知统一提示
                    if (status == "pending") {
                        snapshotPendingCount++
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "event parse error: ${e.message}")
        }
    }

    /** 审查 A-L17：本次连接 snapshot 的 pending 计数（ready 事件后弹 summary） */
    private var snapshotPendingCount = 0

    /** 审批通知 + 直接弹窗（2026-08-14：用户要求弹窗形式——收到请求即弹 dialog，
     * 通知兜底（锁屏/关闭弹窗后可再进）；GcaService 前台服务豁免后台启动限制） */
    private fun notifyApproval(id: String, device: String, operation: String) {
        try {
            ApprovalActivity.launch(context, id)
        } catch (e: Exception) {
            Log.w(TAG, "popup launch failed: ${e.message}")
        }
        val intent = Intent(context, ApprovalActivity::class.java).apply {
            putExtra(ApprovalActivity.EXTRA_OP_ID, id)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pi = PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("审批请求：$device")
            .setContentText("$operation · 点按查看并审批")
            .setContentIntent(pi)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL) // heads-up 弹横幅
            .build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(id.hashCode(), notification)
    }

    private fun cancelNotification(id: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(id.hashCode())
    }

    // 审查 A-H3：createNotificationChannel 是 API 26+——Android 7（minSdk 24）会
    // NoSuchMethodError 崩溃（GcaService/AgentBridge 同款保护）
    private fun ensureChannel() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "GCA 审批", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "设备接入/高危操作审批请求"
                }
            )
        }
    }
}
