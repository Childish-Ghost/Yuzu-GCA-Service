package com.gca.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL

/**
 * Owner 绑定（2026-08-14 App 审批功能）：输入 gca-server 地址 + 管理 token，
 * 校验后存 SharedPreferences("gca")——之后 ApprovalStreamer 自动轮询审批。
 * 提示：owner token 为管理凭据（明文存储风险记录在案，Keystore 加密列为后续）。
 */
class OwnerSetupActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("gca", MODE_PRIVATE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }

        root.addView(TextView(this).apply {
            text = "绑定 GCA 控制面（审批功能）"
            textSize = 20f
        })
        root.addView(TextView(this).apply {
            text = "输入 gca-server 地址与管理 token——用于接收并审批设备接入请求。"
            textSize = 13f
            setPadding(0, 8, 0, 16)
        })

        val etUrl = EditText(this).apply {
            hint = "gca-server 地址（默认 http://<网关IP>:18790）"
            setText(prefs.getString("server_url", "http://<网关IP>:18790"))
        }
        root.addView(etUrl)

        val etToken = EditText(this).apply {
            hint = "管理 token（owner token）"
            // 审查 A-M9：密码属性（输入内容不可旁观）
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        root.addView(etToken)

        val tvStatus = TextView(this).apply {
            textSize = 13f
            setPadding(0, 8, 0, 0)
        }
        root.addView(tvStatus)

        root.addView(Button(this).apply {
            text = "保存并绑定"
            setOnClickListener {
                val url = etUrl.text.toString().trim().trimEnd('/')
                val token = etToken.text.toString().trim()
                if (url.isEmpty() || token.isEmpty()) {
                    tvStatus.text = "地址和 token 都不能为空"
                    return@setOnClickListener
                }
                tvStatus.text = "校验中..."
                Thread {
                    val ok = verify(url, token)
                    Handler(Looper.getMainLooper()).post {
                        if (ok) {
                            prefs.edit()
                                .putString("server_url", url)
                                .apply()
                            OwnerCreds.setOwnerToken(this@OwnerSetupActivity, token) // 审查 A-M9：加密存储
                            tvStatus.text = "✅ 绑定成功，审批功能已启用"
                            // 通知 GcaService 启动审批流
                            startService(Intent(this@OwnerSetupActivity, GcaService::class.java)
                                .setAction(GcaService.ACTION_OWNER_BOUND))
                            Handler(Looper.getMainLooper()).postDelayed({ finish() }, 800)
                        } else {
                            tvStatus.text = "❌ 校验失败（地址/token 不对，或服务器不可达）"
                        }
                    }
                }.start()
            }
        })

        setContentView(root)
    }

    /** 校验：GET /ops?status=pending 带 token 试连 */
    private fun verify(serverUrl: String, token: String): Boolean {
        return try {
            val conn = URL("$serverUrl/ops?status=pending").openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val code = conn.responseCode
            conn.disconnect()
            code == 200
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        fun launch(context: Context) {
            context.startActivity(Intent(context, OwnerSetupActivity::class.java))
        }
    }
}
