package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class Mem : KeyValue {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

class SentLedgerTest {
    @Test
    fun records_are_per_session_and_survive_a_new_instance() {
        val store = Mem()
        SentLedger(store).record("s1", "m1")
        SentLedger(store).record("s2", "m2")
        assertEquals(setOf("m1"), SentLedger(store).mine("s1"))
        assertEquals(setOf("m2"), SentLedger(store).mine("s2"))
    }

    @Test
    fun blank_and_duplicate_ids_are_ignored() {
        val ledger = SentLedger(Mem())
        ledger.record("s", ""); ledger.record("s", "m1"); ledger.record("s", "m1")
        assertEquals(setOf("m1"), ledger.mine("s"))
    }

    @Test
    fun oldest_ids_fall_off_past_the_limit() {
        val ledger = SentLedger(Mem(), limit = 3)
        listOf("a", "b", "c", "d").forEach { ledger.record("s", it) }
        assertEquals(setOf("b", "c", "d"), ledger.mine("s"))
        assertTrue(ledger.mine("other").isEmpty())
    }
}
