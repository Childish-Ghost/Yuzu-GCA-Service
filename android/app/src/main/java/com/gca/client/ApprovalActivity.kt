package com.gca.client

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 审批卡片流（2026-08-14，Authenticator + 卡片交互）：
 *  - 左右滑动切换多条待审批（ViewPager2）
 *  - 上滑通过 / 下滑拒绝（fling 手势）
 *  - 授权前可选生物识别（API 28+）；处理完自动下一条
 *  - 单条模式（通知直达）与列表模式（审批中心）统一走卡片流
 */
class ApprovalActivity : AppCompatActivity() {

    private var serverUrl = "http://<网关IP>:18790"
    private var token = ""
    private lateinit var pager: ViewPager2
    private val ops = mutableListOf<JSONObject>()
    private var deciding = false
    private var singleMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_approval)
        pager = findViewById(R.id.pager)

        val prefs = getSharedPreferences("gca", MODE_PRIVATE)
        serverUrl = prefs.getString("server_url", serverUrl).orEmpty().trimEnd('/')
        // 审查 A-M9：优先加密存储，兼容旧明文
        token = OwnerCreds.getOwnerToken(this)
            ?: prefs.getString("owner_token_plain_fallback", "")
                ?: prefs.getString("owner_token", "").orEmpty()
        if (token.isEmpty()) {
            setEmpty("未绑定 owner（请先在设置中绑定）")
            return
        }

        val targetId = intent.getStringExtra(EXTRA_OP_ID)
        if (targetId != null) {
            singleMode = true
            loadOp(targetId)
        } else {
            loadList()
        }
        // 审查 A-M6：稳定页索引（动画期间 currentItem 不更新）
        pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) { stablePage = position }
        })

    }

    // 手势（2026-08-14 卡片流）：上滑切换下一条 / 下滑切换上一条 /
    // 左滑同意 / 右滑拒绝。放 dispatchTouchEvent——所有触摸必经（子 view/按钮
    // 消费不影响），ViewPager2 原生横向滑动已禁用（左右由手势接管）。
    private var downY = 0f
    private var downX = 0f

    // 审查 A-M6：动画期间 currentItem 不更新（快速连滑会决策错卡片）——用稳定页索引
    private var stablePage = 0

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downY = ev.y; downX = ev.x }
            MotionEvent.ACTION_UP -> {
                if (!deciding && ops.isNotEmpty()) {
                    val dy = ev.y - downY
                    val dx = ev.x - downX
                    val page = stablePage
                    val card = pager.findViewWithTag<View>("card_$page")
                    // 审查 A-M7：决策判定要求横向显著（|dx| > 1.5*|dy|，斜滑不算）
                    if (Math.abs(dx) > 120 && Math.abs(dx) > Math.abs(dy) * 1.5f) {
                        if (card != null) {
                            if (dx < 0) decide(currentOpIdAt(page), "approve", card)
                            else confirmReject(page, card) // 右滑拒绝：二次确认（误滑保护）
                        }
                    } else if (Math.abs(dy) > 120) {
                        // 上滑下一条 / 下滑上一条
                        val target = if (dy < 0) page + 1 else page - 1
                        if (target in 0 until ops.size) pager.setCurrentItem(target, true)
                    }
                }
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun currentOpIdAt(page: Int): String =
        if (ops.isNotEmpty() && page < ops.size) ops[page].optString("id") else ""

    /** 审查 A-M7：右滑拒绝加确认（浏览误滑不直接拒绝设备接入） */
    private fun confirmReject(page: Int, card: View) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("拒绝该请求？")
            .setMessage("设备 ${ops.getOrNull(page)?.optString("device", "-") ?: "-"} 的请求将被拒绝。")
            .setPositiveButton("拒绝") { _, _ -> decide(currentOpIdAt(page), "reject", card) }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 当前页 op id（手势用） */
    private fun currentOpId(): String = if (ops.isNotEmpty() && pager.currentItem < ops.size) {
        ops[pager.currentItem].optString("id")
    } else ""

    /** singleTop 复用（弹窗去重）：新 op 到达时刷新列表/切换单条目标 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 审查 A-M8：单条模式下收到新 op 的通知 → 切换到新 op（不是忽略）
        val newId = intent.getStringExtra(EXTRA_OP_ID)
        if (newId != null && newId != currentOpId()) {
            singleMode = true
            loadOp(newId)
        } else if (!singleMode) {
            loadList()
        }
    }

    // ---------- 数据加载 ----------

    private fun loadOp(id: String) {
        Thread {
            val (code, body) = httpGet("/ops/$id")
            runOnUiThread {
                // 审查 A-L12：200 + 非 JSON body（代理错误页）不崩溃
                if (code == 200) {
                    val op = try { JSONObject(body) } catch (e: Exception) { null }
                    if (op != null) {
                        ops.clear()
                        ops.add(op)
                        bindPager()
                        return@runOnUiThread
                    }
                }
                setEmpty("加载失败（$code）")
            }
        }.start()
    }

    private fun loadList() {
        Thread {
            val (code, body) = httpGet("/ops?status=pending")
            runOnUiThread {
                if (code == 200) {
                    ops.clear()
                    val arr = try { JSONObject(body).getJSONArray("ops") } catch (e: Exception) { null }
                    if (arr != null) for (i in 0 until arr.length()) ops.add(arr.getJSONObject(i))
                    bindPager()
                } else setEmpty("加载失败（$code）")
            }
        }.start()
    }

    private fun httpGet(path: String): Pair<Int, String> {
        return try {
            val conn = URL("$serverUrl$path").openConnection() as HttpURLConnection
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val code = conn.responseCode
            val body = if (code == 200) conn.inputStream.bufferedReader().readText() else ""
            conn.disconnect()
            code to body
        } catch (e: Exception) {
            -1 to ""
        }
    }

    // ---------- 卡片流 ----------

    private fun bindPager() {
        if (ops.isEmpty()) {
            setEmpty(if (singleMode) "请求已过期或不存在" else "暂无待审批请求")
            return
        }
        pager.adapter = ApprovalAdapter()
        pager.isUserInputEnabled = false // 横向滑动由手势接管（左同意/右拒绝）
        pager.setCurrentItem(0, false)
    }

    private fun setEmpty(text: String) {
        // 审查 A-M11：通知权限被拒时审批弹窗仍可用但通知静默——空态附带引导
        var msg = text
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            msg += "\n\n⚠ 通知权限未开启——审批请求无法通过通知提醒，请到系统设置开启（当前页面仍可审批）"
        }
        pager.adapter = EmptyAdapter(msg)
        pager.isUserInputEnabled = false
    }

    inner class ApprovalAdapter : RecyclerView.Adapter<ApprovalAdapter.Holder>() {
        inner class Holder(v: View) : RecyclerView.ViewHolder(v)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_approval, parent, false)
            return Holder(v)
        }

        override fun getItemCount() = ops.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val op = ops[position]
            val v = holder.itemView
            v.findViewById<TextView>(R.id.card_device).text = "设备：${op.optString("device", "-")}"
            v.findViewById<TextView>(R.id.card_operation).text = "请求：${op.optString("operation", "-")}"
            v.findViewById<TextView>(R.id.card_detail).text = "详情：${op.optString("detail", "-")}"
            val ip = op.optString("deviceIp", "")
            val ts = op.optLong("createdAt", 0)
            v.findViewById<TextView>(R.id.card_meta).text =
                "时间：${if (ts > 0) java.text.SimpleDateFormat("MM-dd HH:mm").format(java.util.Date(ts)) else "-"}${if (ip.isNotEmpty()) " · IP $ip" else ""}"
            v.findViewById<TextView>(R.id.card_result).text = ""

            v.findViewById<Button>(R.id.card_approve).setOnClickListener { decide(op.optString("id"), "approve", v) }
            v.findViewById<Button>(R.id.card_reject).setOnClickListener { decide(op.optString("id"), "reject", v) }
            v.tag = "card_${holder.bindingAdapterPosition}"
            // 审查 A-L16：已处理/过期 op 禁用按钮并显示状态
            val status = op.optString("status", "pending")
            if (status != "pending") {
                v.findViewById<Button>(R.id.card_approve).isEnabled = false
                v.findViewById<Button>(R.id.card_reject).isEnabled = false
                v.findViewById<TextView>(R.id.card_result).text = when (status) {
                    "approved" -> "✅ 已授权"
                    "rejected" -> "⛔ 已拒绝"
                    "expired" -> "⏳ 已过期"
                    else -> status
                }
            }
        }
    }

    inner class EmptyAdapter(private val text: String) : RecyclerView.Adapter<EmptyAdapter.H>() {
        inner class H(v: View) : RecyclerView.ViewHolder(v)
        override fun onCreateViewHolder(p: ViewGroup, t: Int): H =
            H(TextView(p.context).apply {
                textSize = 16f
                setPadding(48, 120, 48, 0)
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            })
        override fun getItemCount() = 1
        override fun onBindViewHolder(h: H, pos: Int) {
            (h.itemView as TextView).text = text
        }
    }

    // ---------- 决策（授权/拒绝） ----------

    private fun decide(id: String, action: String, card: View) {
        if (deciding || id.isEmpty()) return
        deciding = true

        val doDecide = {
            Thread {
                try {
                    val conn = URL("$serverUrl/ops/$id/$action").openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 5000
                    conn.readTimeout = 5000
                    val code = conn.responseCode
                    conn.disconnect()
                    runOnUiThread {
                        deciding = false
                        if (code != 200) {
                            card.findViewById<TextView>(R.id.card_result).text = "操作失败（$code）"
                            return@runOnUiThread
                        }
                        val resultText = if (action == "approve") "✅ 已授权" else "⛔ 已拒绝"
                        card.findViewById<TextView>(R.id.card_result).text = resultText
                        card.findViewById<Button>(R.id.card_approve).isEnabled = false
                        card.findViewById<Button>(R.id.card_reject).isEnabled = false
                        Handler(Looper.getMainLooper()).postDelayed({
                            // 审查 A-H1：按 id 删除（决策期间用户可能已滑到别的卡——用 currentItem 会错删/越界）
                            val removed = ops.removeAll { it.optString("id") == id }
                            if (removed && ops.isEmpty()) {
                                setEmpty(if (singleMode) "✅ 已处理" else "全部处理完成 ✓")
                                Handler(Looper.getMainLooper()).postDelayed({ finish() }, 800)
                            } else if (removed) {
                                pager.adapter?.notifyDataSetChanged()
                                pager.setCurrentItem(stablePage, false)
                            }
                        }, 400)
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        deciding = false
                        card.findViewById<TextView>(R.id.card_result).text = "操作失败：${e.message}"
                    }
                }
            }.start()
        }

        // 授权前生物识别（API 28+）；低版本/无硬件降级直接授权
        if (action == "approve" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val executor = ContextCompat.getMainExecutor(this)
            val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { doDecide() }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    deciding = false
                    card.findViewById<TextView>(R.id.card_result).text = "已取消：$errString"
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("确认授权")
                .setNegativeButtonText("取消")
                .build()
            try {
                prompt.authenticate(info)
            } catch (e: Exception) {
                doDecide()
            }
        } else {
            doDecide()
        }
    }

    companion object {
        const val EXTRA_OP_ID = "op_id"
        fun launch(context: Context, opId: String?) {
            context.startActivity(Intent(context, ApprovalActivity::class.java).apply {
                putExtra(EXTRA_OP_ID, opId)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            })
        }
    }
}
