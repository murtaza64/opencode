package ai.opencode.desk

import ai.opencode.desk.model.StateResponse
import ai.opencode.desk.net.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

// android-lead#48: the exact Mini state (mac-mini-setup/bug05/es-api-state-opencode.json). The
// Relay thread ses_7efac8ae… must list as busy and open its owner session with the session's
// REAL directory for /oc calls, and lane-less session threads must be listed too.
class RelayThreadTest {
    private val state = json.decodeFromString<StateResponse>(javaClass.getResource("/mini-state-full.json")!!.readText())
    private val agents = Agents.derive("opencode", state)

    @Test
    fun relay_row_is_busy_and_opens_its_owner_session_with_the_real_directory() {
        val relay = agents.single { it.lane == "orchestrator" }
        assertEquals("busy", relay.status)
        assertNotNull(relay.session)
        assertEquals("ses_7efac8ae359f5cc8eed9a52ed73b2344", relay.session!!.id)
        assertEquals("/Users/murtaza/opencode/.editspace/lanes/orchestrator/repos/murtaza64/opencode", relay.directory)
        assertEquals("opencode/orchestrator", relay.key)
        assertEquals(Pin("opencode", "orchestrator"), relay.pin)
    }

    @Test
    fun every_lane_in_the_mini_state_resolves_a_session_and_none_is_starting() {
        val laned = agents.filter { it.lane.isNotBlank() }
        assertEquals(state.threads.sumOf { it.lanes.size }, laned.size)
        laned.forEach { a ->
            assertNotNull("lane ${a.lane} session", a.session)
            assertTrue("lane ${a.lane} status ${a.status}", a.status != "starting")
            assertTrue("lane ${a.lane} dir", a.directory.isNotBlank())
        }
    }

    @Test
    fun a_lane_less_session_thread_is_listed_and_openable() {
        val loose = state.copy(threads = state.threads + ai.opencode.desk.model.Thread(
            kind = "session", key = "ses_solo", title = "Ad-hoc session", lanes = emptyList(),
            sessions = listOf(ai.opencode.desk.model.DashSession("ses_solo", "Ad-hoc session", "busy", 9.0, 0.0, "/Users/murtaza/opencode/.editspace")),
        ))
        val rows = Agents.derive("opencode", loose)
        val solo = rows.single { it.session?.id == "ses_solo" }
        assertEquals("", solo.lane)
        assertEquals("opencode#ses_solo", solo.key)
        assertEquals("busy", solo.status)
        assertEquals("/Users/murtaza/opencode/.editspace", solo.directory)
        assertEquals(Pin("opencode", sessionID = "ses_solo"), solo.pin)
        assertEquals(1, rows.count { it.session?.id == "ses_7efac8ae359f5cc8eed9a52ed73b2344" })
    }
}
