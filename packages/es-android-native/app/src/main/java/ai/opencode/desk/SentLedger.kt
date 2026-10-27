package ai.opencode.desk

// Message ids this phone's own inputs became, per session, kept across restarts so "you"
// stays provable. Bounded per session; the oldest ids fall off first.
class SentLedger(private val store: KeyValue, private val limit: Int = 200) {
    private fun key(sessionID: String) = "sent:$sessionID"

    fun mine(sessionID: String): Set<String> = store.get(key(sessionID))?.split(',')?.filter { it.isNotBlank() }?.toSet().orEmpty()

    fun record(sessionID: String, messageID: String) {
        if (messageID.isBlank()) return
        val current = store.get(key(sessionID))?.split(',')?.filter { it.isNotBlank() }.orEmpty()
        if (messageID in current) return
        store.put(key(sessionID), (current + messageID).takeLast(limit).joinToString(","))
    }
}
