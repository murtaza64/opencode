package ai.opencode.desk

import ai.opencode.desk.model.MessageInfo
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.SessionTime
import org.junit.Assert.assertEquals
import org.junit.Test

private fun msg(id: String, created: Long) = MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = created)))

class MessagePagingTest {
    @Test
    fun newest_page_replaces_the_tail_and_keeps_older_pages() {
        val loaded = listOf(msg("m1", 1), msg("m2", 2), msg("m3", 3), msg("m4", 4))
        val newest = listOf(msg("m3", 3), msg("m4", 4), msg("m5", 5))
        assertEquals(listOf("m1", "m2", "m3", "m4", "m5"), mergeNewest(loaded, newest).map { it.info.id })
    }

    @Test
    fun first_load_is_just_the_page() {
        assertEquals(listOf("a", "b"), mergeNewest(emptyList(), listOf(msg("a", 1), msg("b", 2))).map { it.info.id })
    }

    @Test
    fun empty_page_keeps_what_was_loaded() {
        val loaded = listOf(msg("m1", 1))
        assertEquals(loaded, mergeNewest(loaded, emptyList()))
    }

    @Test
    fun a_stale_duplicate_newer_than_the_page_window_is_dropped() {
        // An id that vanished server-side (e.g. reverted) and is newer than the page's oldest row is not kept.
        val loaded = listOf(msg("m1", 1), msg("gone", 9))
        val newest = listOf(msg("m2", 2), msg("m3", 3))
        assertEquals(listOf("m1", "m2", "m3"), mergeNewest(loaded, newest).map { it.info.id })
    }
}
