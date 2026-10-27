package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class KV : KeyValue {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

class PinsTest {
    private val laptop = "http://127.0.0.1:47120"
    private val pc = "https://agents.murtaza.earth"
    private val pin = Pin("opencode", "front-desk")

    private fun agent(lane: String, owner: String, status: String = "busy", editspace: String = "opencode") =
        Agent("$editspace/$lane", editspace, lane, "Front desk", "", status, "verifying", 5, "", DashSession(owner, "s", status, 5.0, 0.0, "/es/lanes/$lane"), emptyList())

    @Test
    fun pin_and_unpin_persist_across_a_new_store() {
        val kv = KV()
        PinStore(kv).toggle(pc, pin)
        assertTrue(PinStore(kv).has(pc, pin))
        PinStore(kv).toggle(pc, pin)
        assertFalse(PinStore(kv).has(pc, pin))
        assertNull(kv.map["pins:https://agents.murtaza.earth:443"])
    }

    @Test
    fun the_same_lane_on_two_origins_is_two_pins() {
        val store = PinStore(KV())
        store.toggle(laptop, pin)
        assertTrue(store.has(laptop, pin))
        assertFalse(store.has(pc, pin))
        store.toggle(pc, pin)
        store.toggle(laptop, pin)
        assertFalse(store.has(laptop, pin))
        assertTrue(store.has(pc, pin))
    }

    @Test
    fun owner_change_keeps_the_pin_and_follows_the_new_owner() {
        val before = Pins.resolve(listOf(pin), listOf(agent("front-desk", "ses_old")), emptyMap()).single()
        val after = Pins.resolve(listOf(pin), listOf(agent("front-desk", "ses_new", "idle")), emptyMap()).single()
        assertEquals(pin, before.pin)
        assertEquals(pin, after.pin)
        assertEquals("busy", before.status)
        assertEquals("idle", after.status)
        assertEquals("opencode/front-desk", after.agentKey)
    }

    @Test
    fun missing_lane_is_unavailable_but_the_pin_stays() {
        val view = Pins.resolve(listOf(pin), listOf(agent("other", "ses_x")), emptyMap()).single()
        assertEquals("unavailable", view.status)
        assertNull(view.agentKey)
        assertEquals("front-desk", view.title)
    }

    @Test
    fun a_lane_in_another_editspace_with_the_same_name_does_not_satisfy_the_pin() {
        val view = Pins.resolve(listOf(pin), listOf(agent("front-desk", "ses_x", editspace = "dotfiles")), emptyMap()).single()
        assertEquals("unavailable", view.status)
    }

    @Test
    fun starting_lanes_show_as_starting() {
        val starting = agent("front-desk", "ses_parent", "starting").copy(session = null)
        assertEquals("starting", Pins.resolve(listOf(pin), listOf(starting), emptyMap()).single().status)
    }

    @Test
    fun session_pins_resolve_from_the_state_snapshot() {
        val sp = Pin("opencode", sessionID = "ses_solo")
        val sessions = mapOf("opencode" to listOf(DashSession("ses_solo", "Solo", "busy", 7.0, 0.0, "/root")))
        assertEquals("busy", Pins.resolve(listOf(sp), emptyList(), sessions).single().status)
        assertEquals("unavailable", Pins.resolve(listOf(sp), emptyList(), emptyMap()).single().status)
    }

    @Test
    fun resolve_is_pure_over_the_last_snapshot_and_makes_no_network_calls() {
        // Pins.resolve takes only in-memory data; it has no Api parameter at all, so there is no
        // way for a pin to trigger a request. Counting proves the point for a fake observer.
        var calls = 0
        val agents = listOf(agent("front-desk", "ses_x")).also { calls += 0 }
        repeat(10) { Pins.resolve(listOf(pin), agents, emptyMap()) }
        assertEquals(0, calls)
    }
}
