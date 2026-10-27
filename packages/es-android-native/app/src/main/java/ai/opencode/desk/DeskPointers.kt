package ai.opencode.desk

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.UUID

// Where this phone's Front Desk conversation lives, per gateway. Each gateway is a different
// host with its own Core, so the desk session id, the directory it was created under and
// whether creation completed are all keyed by the normalised gateway origin. The directory
// is pinned at creation: Core routes by directory, so reading the session back under any
// other directory returns nothing and the chat looks empty.
data class DeskPointer(val id: String, val directory: String, val space: String, val ready: Boolean)

interface KeyValue {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

class DeskPointers(private val store: KeyValue) {
    fun get(origin: String): DeskPointer? {
        val prefix = prefix(origin)
        val id = store.get("$prefix:id") ?: return null
        val directory = store.get("$prefix:directory") ?: return null
        return DeskPointer(id, directory, store.get("$prefix:space").orEmpty(), store.get("$prefix:ready") == "true")
    }

    // Returns the existing pointer when one exists so a retry never creates a second desk.
    fun create(origin: String, space: String, directory: String): DeskPointer {
        get(origin)?.let { return it }
        val prefix = prefix(origin)
        val pointer = DeskPointer("ses_desk_${UUID.randomUUID().toString().replace("-", "").take(20)}", directory, space, false)
        store.put("$prefix:id", pointer.id)
        store.put("$prefix:directory", pointer.directory)
        store.put("$prefix:space", pointer.space)
        store.put("$prefix:ready", "false")
        return pointer
    }

    fun markReady(origin: String): DeskPointer? {
        val pointer = get(origin) ?: return null
        store.put("${prefix(origin)}:ready", "true")
        return pointer.copy(ready = true)
    }

    fun clear(origin: String) {
        val prefix = prefix(origin)
        listOf("id", "directory", "space", "ready").forEach { store.put("$prefix:$it", null) }
    }

    companion object {
        // scheme://host:port with the default port made explicit, so `https://x`, `https://x/`
        // and `https://X:443` are one gateway.
        fun normalize(origin: String): String {
            val url = origin.trim().toHttpUrlOrNull() ?: return origin.trim().trimEnd('/').lowercase()
            return "${url.scheme}://${url.host.lowercase()}:${url.port}"
        }

        private fun prefix(origin: String) = "desk:${normalize(origin)}"
    }
}
