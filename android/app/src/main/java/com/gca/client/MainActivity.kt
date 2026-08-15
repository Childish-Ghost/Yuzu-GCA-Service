package com.gca.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Minimal launcher activity — starts the GCA service and shows status.
 * Android 原生化 P2 高低版本分支：
 *   API 30+（Android 11+）：截图走 AccessibilityService.takeScreenshot（无需授权弹窗）
 *   API 26-29：截图走 MediaProjection（需一次授权弹窗，onActivityResult 交给 GcaService）
 */
class MainActivity : AppCompatActivity() {

    private var mediaProjectionManager: MediaProjectionManager? = null

    private lateinit var statusText: TextView
    private lateinit var actionButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 审查 A-L15：LinearLayout 容器（TextView + 按钮竖排）——addContentView 会重叠
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }
        statusText = TextView(this).apply { textSize = 18f }
        actionButton = Button(this)
        root.addView(statusText)
        root.addView(actionButton, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 24
        })
        setContentView(root)
        refreshUi()

        // Android 13+ 通知权限（审批通知必需）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 100)
        }

        // Start the foreground service（高低版本：startForegroundService 是 API 26+，
        // API 24-25 用 startService——Android 7 低版本分支）
        val serviceIntent = Intent(this, GcaService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        // 低版本（API 26-29）截图需要 MediaProjection 授权（API 30+ 用 A11y takeScreenshot）
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            mediaProjectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            startActivityForResult(mediaProjectionManager!!.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION)
        }
    }

    /** 审查 A-L15：绑定状态 UI 刷新（onResume——绑定完成返回后更新，不再停留在"未绑定"） */
    private fun refreshUi() {
        val miui = Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true)
        val ownerBound = OwnerCreds.getOwnerToken(this) != null ||
                !getSharedPreferences("gca", MODE_PRIVATE).getString("owner_token_plain_fallback", "").isNullOrEmpty()
        statusText.text = "GCA Client\n\nService starting on port ${GcaService.DEFAULT_PORT}...\nDevice: gca-android\n\nCheck /health on this device's IP:${GcaService.DEFAULT_PORT}" +
                "\n\n审批：" + if (ownerBound) "已绑定（审批通知已启用）" else "未绑定" +
                if (miui) "\n\n⚠ MIUI：请在 设置→应用设置→应用管理→GCA Client→省电策略 选择「无限制」，\n并开启「自启动」，否则系统会杀后台进程" else ""
        actionButton.setText(if (ownerBound) "审批中心" else "绑定控制面（启用审批）")
        actionButton.setOnClickListener {
            val bound = OwnerCreds.getOwnerToken(this) != null ||
                    !getSharedPreferences("gca", MODE_PRIVATE).getString("owner_token_plain_fallback", "").isNullOrEmpty()
            if (bound) ApprovalActivity.launch(this, null) // 列表模式
            else OwnerSetupActivity.launch(this)
        }
    }

    override fun onResume() {
        super.onResume()
        refreshUi() // 从绑定页返回后刷新状态
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_MEDIA_PROJECTION) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                val mp = mediaProjectionManager!!.getMediaProjection(resultCode, data)
                if (mp != null) GcaService.setMediaProjection(mp)
            }
        }
    }

    companion object {
        private const val REQ_MEDIA_PROJECTION = 1001
    }
}
