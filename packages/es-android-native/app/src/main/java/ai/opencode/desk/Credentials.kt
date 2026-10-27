package ai.opencode.desk

import ai.opencode.desk.net.AccessToken

// Credentials scoped to one exact origin (scheme://host:port). The phone may be paired to
// several hosts (laptop over USB, Excalibur over Cloudflare Access, Mini over Tailscale);
// nothing from one origin ever reaches another: not the pairing cookie, not the operator
// cookie, not the Access token. Two stores back this: `plain` for cookies and the saved
// origin list, `secret` for Access tokens (EncryptedSharedPreferences on the device).
class Credentials(private val plain: KeyValue, private val secret: KeyValue) {
    data class Cookie(val name: String, val value: String, val expiresAt: Long)

    private fun key(origin: String) = DeskPointers.normalize(origin)

    // ---- cookies ----
    fun cookies(origin: String, now: Long = System.currentTimeMillis()): List<Cookie> {
        val prefix = "cookie:${key(origin)}:"
        return plain.keys().filter { it.startsWith(prefix) }.mapNotNull { k ->
            val (value, expires) = plain.get(k)?.split("|")?.takeIf { it.size == 2 } ?: return@mapNotNull null
            val at = expires.toLongOrNull() ?: 0L
            if (at < now) { plain.put(k, null); return@mapNotNull null }
            Cookie(k.removePrefix(prefix), value, at)
        }
    }

    fun saveCookie(origin: String, cookie: Cookie) {
        val k = "cookie:${key(origin)}:${cookie.name}"
        if (cookie.expiresAt < System.currentTimeMillis()) plain.put(k, null) else plain.put(k, "${cookie.value}|${cookie.expiresAt}")
    }

    fun hasCookie(origin: String, name: String) = cookies(origin).any { it.name == name }

    // ---- Access token ----
    fun token(origin: String): AccessToken? {
        val id = secret.get("access:${key(origin)}:id") ?: return null
        val value = secret.get("access:${key(origin)}:secret") ?: return null
        return AccessToken(id, value)
    }

    fun saveToken(origin: String, token: AccessToken?) {
        secret.put("access:${key(origin)}:id", token?.id)
        secret.put("access:${key(origin)}:secret", token?.secret)
    }

    // ---- saved origins (the picker) ----
    // An origin is "saved" once it has a pairing cookie; the list is kept so a picker can
    // switch without a code. Order = most recently used first.
    fun saved(): List<String> = plain.get("origins")?.split("\n")?.filter { it.isNotBlank() }.orEmpty()

    fun touch(origin: String) {
        val o = key(origin)
        plain.put("origins", (listOf(o) + saved().filter { it != o }).joinToString("\n"))
    }

    fun paired(origin: String) = hasCookie(origin, "es_remote")

    // Forgetting one origin leaves every other origin paired.
    fun forget(origin: String) {
        val o = key(origin)
        plain.keys().filter { it.startsWith("cookie:$o:") }.forEach { plain.put(it, null) }
        saveToken(origin, null)
        plain.put("origins", saved().filter { it != o }.joinToString("\n").ifBlank { null })
    }

    // One-time migration from the pre-0.1.13 layout: cookies keyed by bare host
    // ("cookie:<host>:<name>") and one global Access token ("access.id"/"access.secret")
    // attach to the current origin, so the existing pairing survives without re-pairing.
    fun migrate(currentOrigin: String, host: String) {
        val o = key(currentOrigin)
        plain.keys().filter { it.startsWith("cookie:$host:") }.forEach { old ->
            val name = old.removePrefix("cookie:$host:")
            plain.get(old)?.let { plain.put("cookie:$o:$name", it) }
            plain.put(old, null)
        }
        val id = secret.get("access.id"); val value = secret.get("access.secret")
        if (id != null && value != null && token(currentOrigin) == null) saveToken(currentOrigin, AccessToken(id, value))
        secret.put("access.id", null); secret.put("access.secret", null)
        if (paired(currentOrigin)) touch(currentOrigin)
    }
}

// KeyValue grows a key listing for stores that need to enumerate (cookies).
interface KeyValueWithKeys : KeyValue { fun keys(): List<String> }

fun KeyValue.keys(): List<String> = (this as? KeyValueWithKeys)?.keys() ?: emptyList()
