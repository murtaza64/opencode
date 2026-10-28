package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.LaneRecord
import ai.opencode.desk.net.json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

// Exact BUG05 repro from the Mini (mac-mini-setup#257, read-only /api/state?es=opencode sample):
// every lane's owner session is present and live, but lane.dir is spelled ~/editspaces/… while
// session.directory is ~/opencode/.editspace/…. The pre-0.1.17 containment check matched nothing
// and showed every lane as "starting".
class MiniSampleTest {
    private val sample = json.parseToJsonElement(javaClass.getResource("/mini-state-sample.json")!!.readText()).jsonObject

    private fun lanes() = sample["lanes"]!!.jsonArray.map { it.jsonObject }

    @Test
    fun every_mini_lane_resolves_to_its_live_owner_session_not_starting() {
        val expected = mapOf(
            "remote-host-client" to "busy", "front-desk" to "busy", "ux-feel" to "parked",
            "performance-lead-sustained-daemon-and-desktop-reliability" to "busy", "orchestrator" to "busy",
            "composer-refs-mention-lane-title-pending-image-echo" to "busy",
        )
        lanes().forEach { entry ->
            val l = entry["lane"]!!.jsonObject
            val lane = LaneRecord(
                lane = l["lane"]!!.jsonPrimitive.content, owner = l["owner"]!!.jsonPrimitive.content, activity = l["activity"]!!.jsonPrimitive.content,
                activity_at = l["activity_at"]!!.jsonPrimitive.content, activity_session = l["activity_session"]!!.jsonPrimitive.content,
                status = l["status"]!!.jsonPrimitive.content, dir = l["dir"]!!.jsonPrimitive.content,
            )
            val sessions = entry["sessions"]!!.jsonArray.map { s -> s.jsonObject.let { DashSession(it["id"]!!.jsonPrimitive.content, it["title"]!!.jsonPrimitive.content, it["live"]!!.jsonPrimitive.content, it["updated"]!!.jsonPrimitive.content.toDouble(), 0.0, it["directory"]!!.jsonPrimitive.content) } }
            val own = Anchors.pick(lane, sessions)
            assertNotNull("lane ${lane.lane} must resolve its owner", own)
            assertEquals(lane.owner, own!!.id)
            val status = Anchors.status(lane, own, Anchors.anchored(lane, sessions, own))
            assertEquals("lane ${lane.lane}", expected[lane.lane], status)
        }
    }

    @Test
    fun the_old_containment_rule_alone_would_have_matched_nothing_on_the_mini() {
        lanes().forEach { entry ->
            val dir = entry["lane"]!!.jsonObject["dir"]!!.jsonPrimitive.content
            entry["sessions"]!!.jsonArray.forEach { s ->
                val sessionDir = s.jsonObject["directory"]!!.jsonPrimitive.content
                assert(!sessionDir.startsWith(dir)) { "sample no longer reproduces the symlink split" }
                assert(Anchors.normalize(sessionDir).startsWith(Anchors.normalize(dir))) { "normalised containment must hold" }
            }
        }
    }
}
