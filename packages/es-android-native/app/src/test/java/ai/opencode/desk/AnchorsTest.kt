package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.LaneRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnchorsTest {
    private val lane = LaneRecord(lane = "worker", owner = "ses_parent", activity_session = "", dir = "/es/lanes/worker")
    private val parent = DashSession("ses_parent", "Relay", "busy", 10.0, 0.0, "/es/lanes/orchestrator/repos/o/r")
    private val worker = DashSession("ses_worker", "Worker", "idle", 5.0, 0.0, "/es/lanes/worker/repos/o/r")
    private val older = DashSession("ses_old", "Older", "idle", 1.0, 0.0, "/es/lanes/worker")
    private val lookalike = DashSession("ses_like", "Lookalike", "busy", 9.0, 0.0, "/es/lanes/worker-2/repos/o/r")

    @Test
    fun a_parent_session_outside_the_lane_is_never_the_lane() {
        assertFalse(Anchors.inLane(lane, parent))
        assertNull(Anchors.pick(lane, listOf(parent)))
        assertEquals("starting", Anchors.status(lane, null, emptyList()))
    }

    @Test
    fun the_owner_is_used_only_once_it_is_anchored_in_the_lane() {
        val owned = lane.copy(owner = "ses_worker")
        assertEquals(worker, Anchors.pick(owned, listOf(parent, worker, older)))
        assertEquals(older, Anchors.pick(owned.copy(owner = "ses_old"), listOf(worker, older)))
    }

    @Test
    fun without_a_matching_owner_the_newest_anchored_session_is_used() {
        assertEquals(worker, Anchors.pick(lane, listOf(parent, older, worker)))
    }

    @Test
    fun a_sibling_lane_with_the_same_prefix_does_not_match() {
        assertFalse(Anchors.inLane(lane, lookalike))
        assertTrue(Anchors.inLane(lane, older))
        assertTrue(Anchors.inLane(lane.copy(dir = "/es/lanes/worker/"), worker))
    }

    @Test
    fun a_lane_without_a_directory_matches_nothing() {
        assertFalse(Anchors.inLane(lane.copy(dir = ""), worker))
    }

    @Test
    fun busy_comes_only_from_anchored_sessions() {
        assertEquals("idle", Anchors.status(lane, worker, listOf(worker)))
        assertEquals("busy", Anchors.status(lane, worker, listOf(worker.copy(live = "busy"))))
        assertEquals("parked", Anchors.status(lane.copy(status = "parked"), worker, listOf(worker)))
    }
}
