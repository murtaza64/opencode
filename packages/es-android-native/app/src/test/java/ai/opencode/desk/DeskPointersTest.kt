package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class MemoryStore : KeyValue {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

class DeskPointersTest {
    private val laptop = "http://127.0.0.1:47120"
    private val pc = "https://agents.murtaza.earth"

    @Test
    fun each_gateway_gets_its_own_desk() {
        val pointers = DeskPointers(MemoryStore())
        val a = pointers.create(laptop, "opencode", "/Users/m/opencode/.editspace")
        val b = pointers.create(pc, "manadj", "/home/m/manadj/.editspace")
        assertNotEquals(a.id, b.id)
        assertEquals(a, pointers.get(laptop))
        assertEquals(b, pointers.get(pc))
    }

    @Test
    fun a_ready_desk_on_one_gateway_does_not_leak_to_another() {
        val pointers = DeskPointers(MemoryStore())
        pointers.create(laptop, "opencode", "/laptop")
        pointers.markReady(laptop)
        assertNull(pointers.get(pc))
        assertFalse(pointers.create(pc, "manadj", "/pc").ready)
    }

    @Test
    fun directory_is_pinned_at_creation() {
        val pointers = DeskPointers(MemoryStore())
        val first = pointers.create(pc, "manadj", "/pc/manadj")
        val again = pointers.create(pc, "personal", "/pc/personal")
        assertEquals(first, again)
        assertEquals("/pc/manadj", pointers.get(pc)!!.directory)
        assertEquals("manadj", pointers.get(pc)!!.space)
    }

    @Test
    fun mark_ready_keeps_id_and_directory() {
        val pointers = DeskPointers(MemoryStore())
        val created = pointers.create(pc, "manadj", "/pc/manadj")
        val ready = pointers.markReady(pc)!!
        assertTrue(ready.ready)
        assertEquals(created.id, ready.id)
        assertEquals(created.directory, ready.directory)
        assertEquals(ready, pointers.get(pc))
    }

    @Test
    fun mark_ready_without_a_pointer_does_nothing() {
        assertNull(DeskPointers(MemoryStore()).markReady(pc))
    }

    @Test
    fun origin_spelling_variants_are_one_gateway() {
        val pointers = DeskPointers(MemoryStore())
        val created = pointers.create("https://Agents.murtaza.earth/", "manadj", "/pc")
        assertEquals(created, pointers.get("https://agents.murtaza.earth"))
        assertEquals(created, pointers.get("https://agents.murtaza.earth:443"))
        assertNull(pointers.get("http://agents.murtaza.earth"))
    }

    @Test
    fun normalize_makes_the_port_explicit() {
        assertEquals("https://agents.murtaza.earth:443", DeskPointers.normalize("https://agents.murtaza.earth/"))
        assertEquals("http://127.0.0.1:47120", DeskPointers.normalize("http://127.0.0.1:47120"))
    }

    @Test
    fun ids_are_client_chosen_desk_sessions() {
        val id = DeskPointers(MemoryStore()).create(pc, "manadj", "/pc").id
        assertTrue(id, id.startsWith("ses_desk_") && id.length == 29)
    }

    @Test
    fun clear_forgets_only_that_gateway() {
        val pointers = DeskPointers(MemoryStore())
        pointers.create(laptop, "opencode", "/laptop")
        pointers.create(pc, "manadj", "/pc")
        pointers.clear(pc)
        assertNull(pointers.get(pc))
        assertEquals("/laptop", pointers.get(laptop)!!.directory)
    }

    @Test
    fun legacy_global_keys_are_not_a_pointer() {
        val store = MemoryStore()
        store.map["desk.id"] = "ses_desk_old"
        store.map["desk.ready"] = "true"
        assertNull(DeskPointers(store).get(pc))
    }
}
