package ai.opencode.desk

import ai.opencode.desk.model.StateResponse
import ai.opencode.desk.net.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// android-lead#53: the Mini Relay root rolled over from ses_7efac8ae… to ses_e7fbd738… (lane
// orchestrator, owner = activity_session = e7fb, session.directory is the real path while
// lane.dir is the symlink spelling). The Home pinned row and the Agents row must target e7fb,
// the old session stays listed as history and openable, and the row title is the agent's
// display name, never a stale session title.
class RelayRolloverTest {
    private val state = json.decodeFromString<StateResponse>(javaClass.getResource("/mini-state-rollover.json")!!.readText())
    private val agents = Agents.derive("opencode", state)
    private val relay = agents.single { it.lane == "orchestrator" }
    private val new = "ses_e7fbd738cffenSQHMiPq6iSx7Z"
    private val old = "ses_7efac8ae359f5cc8eed9a52ed73b2344"

    @Test
    fun agents_row_targets_the_rolled_over_session() {
        assertEquals(new, relay.session?.id)
        assertEquals("busy", relay.status)
        assertEquals("/Users/murtaza/opencode/.editspace/lanes/orchestrator/repos/murtaza64/opencode", relay.directory)
        assertEquals("opencode/orchestrator", relay.key)
    }

    @Test
    fun home_pinned_row_targets_the_rolled_over_session() {
        val view = Pins.resolve(listOf(Pin("opencode", "orchestrator")), agents, mapOf("opencode" to state.sessions)).single()
        assertEquals("opencode/orchestrator", view.agentKey)
        assertEquals("busy", view.status)
        assertEquals(relay.title, view.title)
    }

    @Test
    fun old_session_is_history_and_openable_and_not_a_second_row() {
        assertEquals(listOf(new, old), relay.sessions.map { it.id })
        assertEquals(1, agents.count { it.session?.id == old || it.sessions.any { s -> s.id == old } })
        assertTrue(relay.history.any { it.id == old })
        assertTrue(relay.history.none { it.id == new })
    }

    @Test
    fun title_is_the_display_name_and_lane_name_is_shown_when_it_differs() {
        assertEquals("Relay (Mini receiving orchestrator)", relay.title)
        assertEquals("orchestrator", relay.laneLabel)
    }

    @Test
    fun a_stale_thread_title_from_an_older_session_is_replaced_by_the_head_session_title() {
        val stale = state.copy(threads = state.threads.map { t ->
            if (t.lanes.none { it.lane == "orchestrator" }) t
            else t.copy(title = "Old relay (retired)", sessions = t.sessions.map { s -> if (s.id == old) s.copy(title = "Old relay (retired)") else s })
        })
        val row = Agents.derive("opencode", stale).single { it.lane == "orchestrator" }
        assertEquals("Relay (Mini receiving orchestrator)", row.title)
    }

    @Test
    fun search_finds_the_relay_by_title_lane_project_and_session_id_prefix() {
        listOf("Relay", "relay", "orchestrator", "opencode", "ses_e7fb", "e7fbd7").forEach { q ->
            assertEquals(q, "opencode/orchestrator", Agents.search(agents, q).single { it.lane == "orchestrator" }.key)
        }
        assertTrue(Agents.search(agents, "ses_7efac").any { it.key == "opencode/orchestrator" })
        assertEquals(agents, Agents.search(agents, ""))
        assertTrue(Agents.search(agents, "zzz-nothing").isEmpty())
    }
}
