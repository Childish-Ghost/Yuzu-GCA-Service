package com.gca.client

import android.app.*
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.File
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * GCA MCP Server foreground service.
 * Starts the Rust agent (libgca_agent.so) that runs our MCP server.
 * The server listens on a port accessible from the LAN.
 * Android 原生化（docs/android-native-plan.md P1）——nodejs-mobile 已退出。
 */
class GcaService : Service() {

    companion object {
        const val TAG = "GCA"
        const val CHANNEL_ID = "gca-service"
        const val DEFAULT_PORT = 3003
        /** owner 绑定完成广播（OwnerSetupActivity → 启动审批流） */
        const val ACTION_OWNER_BOUND = "com.gca.client.OWNER_BOUND"

        @Volatile
        private var instance: GcaService? = null

        /** AgentBridge 低版本截图取服务实例（API 26-29 MediaProjection 路径） */
        fun agentInstance(): GcaService? = instance

        /** MainActivity 低版本 MediaProjection 授权结果注入（API 30+ 不走此路径） */
        fun setMediaProjection(mp: MediaProjection) {
            instance?.setupMediaProjection(mp)
        }
    }

    // Rust agent 线程由 native 侧 spawn（多次 onStartCommand 不会重复起服务——
    // 端口占用会失败并记日志；同步锁防同一帧双触发）
    private var agentStarted = false

    /** 启动审批下发流（幂等） */
    private fun startApprovalStreamer() {
        if (approvalStreamer == null) {
            approvalStreamer = ApprovalStreamer(this).also { it.start() }
            Log.i(TAG, "Approval streamer started")
        }
    }

    // ---------- 低版本截图（API 26-29 MediaProjection；API 30+ 走 A11y，无需此路径） ----------
    private var mediaProjection: MediaProjection? = null
    private var imageReader: android.media.ImageReader? = null
    private var virtualDisplay: android.hardware.display.VirtualDisplay? = null

    private fun setupMediaProjection(mp: MediaProjection) {
        synchronized(this) {
            try {
                val metrics = resources.displayMetrics
                val w = metrics.widthPixels
                val h = metrics.heightPixels
                val dpi = metrics.densityDpi
                imageReader = android.media.ImageReader.newInstance(w, h, android.graphics.PixelFormat.RGBA_8888, 2)
                virtualDisplay = mp.createVirtualDisplay(
                    "gca-capture", w, h, dpi,
                    android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader!!.surface, null, null
                )
                mediaProjection = mp
                Log.i(TAG, "MediaProjection ready: ${w}x${h}@$dpi (low-API screenshot path)")
            } catch (e: Exception) {
                Log.e(TAG, "MediaProjection setup failed", e)
                mp.stop()
            }
        }
    }

    /** 低版本截图：从 ImageReader 抓最新帧 → JPEG bytes（API 30+ 不调用） */
    fun captureFrameFromProjection(): ByteArray? {
        synchronized(this) {
            val reader = imageReader ?: return null
            val image = reader.acquireLatestImage() ?: return null
            return try {
                val plane = image.planes[0]
                val w = image.width
                val h = image.height
                val rowStride = plane.rowStride
                val pixelStride = plane.pixelStride
                val buf = plane.buffer
                val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(buf)
                val out = java.io.ByteArrayOutputStream()
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                bmp.recycle()
                out.toByteArray()
            } catch (e: Exception) {
                Log.e(TAG, "captureFrameFromProjection failed", e)
                null
            } finally {
                image.close()
            }
        }
    }

    // 审批流（2026-08-14）：SSE 下发 + 通知/弹窗审批
    private var approvalStreamer: ApprovalStreamer? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        // Rust agent JNI 回调桥（Android 原生化 P2）
        AgentBridge.init(this)
        // 审批下发流：owner 已绑定则启动（SSE 长连接）
        if (!OwnerCreds.getOwnerToken(this).isNullOrEmpty()) {
            startApprovalStreamer()
        }
    }

    override fun onDestroy() {
        // 审查 A-M4：service 销毁时停审批流（中断 SSE reader，防线程/连接泄漏）
        approvalStreamer?.stop()
        approvalStreamer = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // owner 绑定完成通知（OwnerSetupActivity 触发）→ 启动审批流
        if (intent?.action == ACTION_OWNER_BOUND) {
            startApprovalStreamer()
        }
        // 高低版本：Notification.Builder(Context, channelId) 是 API 26+，
        // API 24-25 用无 channel 构造（Android 7 低版本分支）
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("GCA MCP Server")
                .setContentText("Running on port $DEFAULT_PORT")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
        } else {
            Notification.Builder(this)
                .setContentTitle("GCA MCP Server")
                .setContentText("Running on port $DEFAULT_PORT")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
        }
        startForeground(1, notification)

        synchronized(this) {
            if (agentStarted) {
                Log.i(TAG, "Rust agent already started, skipping duplicate start")
                return START_STICKY
            }
            agentStarted = true
        }

        Thread {
            Log.i(TAG, "Starting Rust agent MCP server...")
            try {
                // P3（S1）：设备自铸 token（替代 assets 的 owner token 遗留——授权坍缩）
                pairingToken = ensureDeviceToken()
                deviceName = generateDeviceName()
                machineId = generateMachineId()

                // Try registration with gca-server（S1：body 携 deviceToken，设备通道）
                // serverUrl 从 owner 绑定配置读取（2026-08-14），缺省用默认
                val serverUrl = getSharedPreferences("gca", MODE_PRIVATE)
                    .getString("server_url", "http://<网关IP>:18790").orEmpty()
                tryRegister(pairingToken, machineId, serverUrl)

                // Rust 侧自起服务线程（nativeStart 非阻塞，token/端口经 JNI 参数注入；
                // P3 加 machineId——心跳/注册身份；审计推送 Rust 侧默认开）
                NativeBridge.nativeStart(DEFAULT_PORT, pairingToken, deviceName, serverUrl, machineId)
            } catch (e: Exception) {
                Log.e(TAG, "Rust agent startup failed", e)
                synchronized(this) { agentStarted = false }
            }
        }.start()

        return START_STICKY
    }

    private var deviceName = "gca-android"
    private var pairingToken = ""
    private var machineId = ""

    /** S1 设备自铸 token：64-hex，首次生成后持久化（SharedPreferences），重启复用 */
    private fun ensureDeviceToken(): String {
        val prefs = getSharedPreferences("gca", MODE_PRIVATE)
        prefs.getString("device_token", null)?.let { if (it.length >= 32) return it }
        val bytes = ByteArray(32)
        java.security.SecureRandom().nextBytes(bytes)
        val token = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("device_token", token).apply()
        Log.i(TAG, "Device token minted (S1)")
        return token
    }

    /** 设备身份：Build 指纹（device-identity.md）——注册/心跳的 machineId */
    private fun generateMachineId(): String {
        val prefs = getSharedPreferences("gca", MODE_PRIVATE)
        prefs.getString("machine_id", null)?.let { return it }
        val id = Build.FINGERPRINT
        prefs.edit().putString("machine_id", id).apply()
        return id
    }

    private fun generateDeviceName(): String {
        // Reuse saved device name so we don't re-register on every restart
        val nameFile = File(filesDir, "gca-device-name.txt")
        try {
            if (nameFile.exists()) {
                val saved = nameFile.readText().trim()
                if (saved.isNotEmpty()) {
                    Log.i(TAG, "Device name (saved): $saved")
                    return saved
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read saved device name", e)
        }

        val model = Build.MODEL.replace(" ", "-").replace("[^A-Za-z0-9-]".toRegex(), "")
        val suffix = UUID.randomUUID().toString().take(4)
        val name = "gca-${model}-${suffix}"
        try {
            nameFile.writeText(name)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save device name", e)
        }
        Log.i(TAG, "Device name (new): $name")
        return name
    }

    /** S1 注册（设备通道）：body 携 deviceToken（≥32 字符）自证身份 + machineId */
    private fun tryRegister(deviceToken: String, machineId: String, serverUrl: String) {
        try {
            val url = URL("$serverUrl/register")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            // port 必须上报（server 默认 3001——agent 实际监听 DEFAULT_PORT，否则 URL 端口错）
            val body = """{"deviceName":"$deviceName","machineId":"$machineId","deviceToken":"$deviceToken","port":$DEFAULT_PORT}"""
            conn.outputStream.write(body.toByteArray())

            if (conn.responseCode == 200) {
                Log.i(TAG, "Registration request sent for $deviceName")
            } else {
                Log.w(TAG, "Registration request failed: ${conn.responseCode}")
            }
            conn.disconnect()
        } catch (e: Exception) {
            Log.w(TAG, "Cannot reach gca-server for registration: ${e.message}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "GCA Service",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
