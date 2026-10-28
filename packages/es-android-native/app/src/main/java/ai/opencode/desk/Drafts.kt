package ai.opencode.desk

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

// Durable composer drafts (AND-W3). One per (canonical origin, session or desk): text, the
// normalised attachments (already in the outbox image store) and the reserved requestID that
// the eventual send will use, so a draft keeps its pending identity across kill, rotation,
// navigation and host switch. Profiles are separate app instances, so profile is implicit.
// A draft is cleared only when its send is confirmed accepted; it is never listed under
// another origin or session.
@Serializable
data class Draft(
    val origin: String,
    val sessionID: String,
    val requestID: String,
    val text: String = "",
    val images: List<StoredImage> = emptyList(),
    val delivery: String? = null,
    val updatedAt: Long = 0,
) {
    val empty get() = text.isBlank() && images.isEmpty()
}

class DraftStore(private val store: KeyValue) {
    private val json = ai.opencode.desk.net.json
    private fun key(origin: String) = "drafts:${DeskPointers.normalize(origin)}"

    fun list(origin: String): List<Draft> =
        store.get(key(origin))?.let { runCatching { json.decodeFromString(ListSerializer(Draft.serializer()), it) }.getOrNull() }.orEmpty()

    fun get(origin: String, sessionID: String): Draft? = list(origin).firstOrNull { it.sessionID == sessionID }

    fun put(draft: Draft) {
        val others = list(draft.origin).filter { it.sessionID != draft.sessionID }
        val next = if (draft.empty) others else others + draft.copy(origin = DeskPointers.normalize(draft.origin))
        store.put(key(draft.origin), if (next.isEmpty()) null else json.encodeToString(ListSerializer(Draft.serializer()), next))
    }

    // Called only once the send is confirmed accepted (receipt or admission proven).
    fun clear(origin: String, sessionID: String, requestID: String) {
        val current = get(origin, sessionID) ?: return
        // A newer draft with a different reserved id (typed after the send) is left alone.
        if (current.requestID != requestID) return
        put(current.copy(text = "", images = emptyList()))
    }
}
