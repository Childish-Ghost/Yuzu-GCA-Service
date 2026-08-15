package com.gca.client

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * owner 凭据安全存储（2026-08-14 审查 A-M9）：
 * - owner_token 用 EncryptedSharedPreferences（Android Keystore + AES）加密
 * - server_url / 设备身份等非敏感项仍用普通 prefs
 */
object OwnerCreds {

    private const val PREFS = "gca_secure"

    private fun securePrefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context, PREFS, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getOwnerToken(context: Context): String? =
        try { securePrefs(context).getString("owner_token", null) } catch (e: Exception) { null }

    fun setOwnerToken(context: Context, token: String) {
        try {
            securePrefs(context).edit().putString("owner_token", token).apply()
        } catch (e: Exception) {
            // 降级：Keystore 不可用时回退明文 prefs（记录日志）
            android.util.Log.w("OwnerCreds", "secure store failed, fallback to plain: ${e.message}")
            context.getSharedPreferences("gca", Context.MODE_PRIVATE)
                .edit().putString("owner_token_plain_fallback", token).apply()
        }
    }

    fun clearOwnerToken(context: Context) {
        try { securePrefs(context).edit().remove("owner_token").apply() } catch (_: Exception) {}
    }
}
