package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.LaneRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// AND-W1 / BUG05 on the real Mini + Excalibur shape: lanes whose session is missing from the
// loaded page, and lane dirs vs session dirs spelled through different symlink roots.
class AnchorsStatusTest {
    private fun lane(name: String, owner: String, activitySession: String = "", dir: String = "/Users/murtaza/editspaces/opencode/lanes/$name") =
        LaneRecord(lane = name, owner = owner, activity = "verifying $name", activity_at = "2026-10-27T23:00:00Z", activity_session = activitySession, status = "active", dir = dir)
    private fun session(id: String, dir: String, live: String = "idle") = DashSession(id, "t", live, 10.0, 0.0, dir)

    @Test
    fun session_ids_strip_the_lane_record_prefixes() {
        assertEquals("ses_abc", Anchors.sessionID("opencode:ses_abc"))
        assertEquals("ses_abc", Anchors.sessionID("es:ses_abc"))
        assertEquals("ses_abc", Anchors.sessionID("ses_abc"))
        assertNull(Anchors.sessionID("wingman:ses_abc"))
        assertNull(Anchors.sessionID(""))
        assertNull(Anchors.sessionID("not-a-session"))
    }

    @Test
    fun join_by_owner_id_wins_even_when_the_directory_spelling_differs() {
        // Mini: lane.dir under ~/editspaces, session under ~/opencode/.editspace (symlink spelling).
        val l = lane("composer-refs", "opencode:ses_cr", dir = "/Users/murtaza/editspaces/opencode/lanes/composer-refs")
        val s = session("ses_cr", "/Users/murtaza/opencode/.editspace/lanes/composer-refs/repos/murtaza64/opencode", live = "busy")
        assertEquals(s, Anchors.pick(l, listOf(s)))
        assertEquals("busy", Anchors.status(l, s, Anchors.anchored(l, listOf(s), s)))
    }

    @Test
    fun directory_fallback_normalises_symlink_roots() {
        val l = lane("ux-feel", owner = "", dir = "/Users/murtaza/editspaces/opencode/lanes/ux-feel/")
        val s = session("ses_ux", "/Users/murtaza/opencode/.editspace/lanes/ux-feel/repos/murtaza64/opencode")
        assertTrue(Anchors.inLane(l, s))
        assertEquals(s, Anchors.pick(l, listOf(s)))
    }

    @Test
    fun a_recorded_session_missing_from_the_loaded_page_is_unknown_never_starting() {
        val l = lane("relay", "opencode:ses_relay")
        assertNull(Anchors.pick(l, emptyList()))
        assertEquals("unknown", Anchors.status(l, null, emptyList()))
        assertEquals("unknown", Anchors.status(lane("perf", "", activitySession = "ses_perf"), null, emptyList()))
    }

    @Test
    fun starting_only_when_the_lane_record_names_no_session_at_all() {
        val provisional = lane("new-lane", owner = "", activitySession = "")
        assertEquals("starting", Anchors.status(provisional, null, emptyList()))
        // Rook on Excalibur: owner present, session loaded, idle.
        val rook = lane("rook", "ses_rook"); val s = session("ses_rook", "/home/m/editspaces/x/lanes/rook")
        assertEquals("idle", Anchors.status(rook, s, listOf(s)))
    }

    @Test
    fun owner_outside_the_lane_directory_is_still_the_lane_session_when_the_record_names_it() {
        // The lane record is authoritative: a session anchored elsewhere but named as owner is used.
        val l = lane("work-dashboard", "ses_wd")
        val s = session("ses_wd", "/home/m/editspaces/personal", live = "busy")
        assertEquals(s, Anchors.pick(l, listOf(s)))
        assertEquals("busy", Anchors.status(l, s, Anchors.anchored(l, listOf(s), s)))
    }

    @Test
    fun parked_and_wingman_are_preserved() {
        val parked = lane("p", "ses_p").copy(status = "parked")
        assertEquals("parked", Anchors.status(parked, null, emptyList()))
        val wing = lane("w", "wingman:cloud-1")
        assertEquals("unknown", Anchors.status(wing, null, emptyList()))
    }
}
