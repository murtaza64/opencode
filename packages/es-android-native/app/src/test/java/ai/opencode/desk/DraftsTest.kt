package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class DraftKV : KeyValue {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

class DraftsTest {
    private val excalibur = "https://agents.murtaza.earth"
    private val mini = "https://mini.tail:8443"

    @Test
    fun a_draft_survives_a_new_store_instance_with_text_images_and_identity() {
        val kv = DraftKV()
        DraftStore(kv).put(Draft(excalibur, "ses_a", "req-1", "half typed", listOf(StoredImage("outbox/req-1/0.jpg", "image/jpeg", 10, 4, 3)), updatedAt = 5))
        val again = DraftStore(kv).get(excalibur, "ses_a")!!
        assertEquals("half typed", again.text)
        assertEquals("req-1", again.requestID)
        assertEquals(1, again.images.size)
    }

    @Test
    fun drafts_never_show_under_another_origin_or_session() {
        val store = DraftStore(DraftKV())
        store.put(Draft(excalibur, "ses_a", "req-1", "for excalibur"))
        assertNull(store.get(mini, "ses_a"))
        assertNull(store.get(excalibur, "ses_b"))
        assertTrue(store.list(mini).isEmpty())
        assertEquals("for excalibur", store.get("https://AGENTS.murtaza.earth:443/", "ses_a")!!.text)
    }

    @Test
    fun clear_only_applies_to_the_confirmed_send_identity() {
        val store = DraftStore(DraftKV())
        store.put(Draft(excalibur, "ses_a", "req-1", "sent text"))
        store.clear(excalibur, "ses_a", "req-other")
        assertEquals("sent text", store.get(excalibur, "ses_a")!!.text)
        store.clear(excalibur, "ses_a", "req-1")
        assertNull(store.get(excalibur, "ses_a"))
    }

    @Test
    fun an_empty_draft_is_removed_and_one_per_session_is_kept() {
        val store = DraftStore(DraftKV())
        store.put(Draft(excalibur, "ses_a", "req-1", "a"))
        store.put(Draft(excalibur, "ses_a", "req-1", "ab"))
        store.put(Draft(excalibur, "ses_b", "req-2", "b"))
        assertEquals(listOf("ab", "b"), store.list(excalibur).sortedBy { it.sessionID }.map { it.text })
        store.put(Draft(excalibur, "ses_a", "req-1", ""))
        assertEquals(listOf("b"), store.list(excalibur).map { it.text })
    }
}
