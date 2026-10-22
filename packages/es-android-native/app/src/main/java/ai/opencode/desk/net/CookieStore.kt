package ai.opencode.desk.net

import android.content.SharedPreferences
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// Persists the two gateway cookies (es_remote pairing, es_attention_operator) in
// app-private storage keyed by host so a restart does not require re-pairing.
// Values are credentials: never logged, never shown.
class CookieStore(private val prefs: SharedPreferences) : CookieJar {
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val editor = prefs.edit()
        cookies.forEach { cookie ->
            val key = "cookie:${url.host}:${cookie.name}"
            if (cookie.expiresAt < System.currentTimeMillis()) editor.remove(key)
            else editor.putString(key, "${cookie.value}|${cookie.expiresAt}")
        }
        editor.apply()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> =
        prefs.all.entries.mapNotNull { (key, raw) ->
            if (!key.startsWith("cookie:${url.host}:")) return@mapNotNull null
            val (value, expires) = (raw as? String)?.split("|")?.takeIf { it.size == 2 } ?: return@mapNotNull null
            if ((expires.toLongOrNull() ?: 0) < System.currentTimeMillis()) return@mapNotNull null
            Cookie.Builder().name(key.substringAfterLast(':')).value(value).domain(url.host).path("/").build()
        }

    fun has(origin: String, name: String): Boolean {
        val host = origin.toHttpUrlOrNullSafe()?.host ?: return false
        return prefs.contains("cookie:$host:$name")
    }

    fun clear() {
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith("cookie:") }.forEach(editor::remove)
        editor.apply()
    }
}

private fun String.toHttpUrlOrNullSafe() = toHttpUrlOrNull()
