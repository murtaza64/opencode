package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.LaneRecord

// Which session a lane row stands for, and what status it shows (AND-W1 / BUG05).
// Join order: the lane's recorded session id first (owner / activity_session, prefix-stripped,
// as the desktop does), then directory containment with both paths normalised. "starting" is
// shown only when the lane record itself says the lane is provisional (no owner recorded); a
// session that is merely absent from the loaded page is "unknown", never "starting".
object Anchors {
    // Lane records may spell session ids as "opencode:ses_…" or "es:ses_…"; wingman owners stay distinct.
    fun sessionID(value: String): String? {
        val v = value.trim()
        if (v.isEmpty() || v.startsWith("wingman:")) return null
        return v.substringAfterLast(':').takeIf { it.startsWith("ses_") } ?: v.takeIf { it.startsWith("ses_") }
    }

    // Collapses symlink spellings so `~/editspaces/<es>/lanes/x` and `~/opencode/.editspace/lanes/x`
    // compare equal: keep the path from the first `lanes/` segment when present, trim slashes.
    fun normalize(path: String): String {
        val p = path.trim().trimEnd('/')
        val idx = p.indexOf("/lanes/")
        return if (idx >= 0) p.substring(idx) else p
    }

    fun inLane(lane: LaneRecord, session: DashSession): Boolean {
        val dir = normalize(lane.dir)
        if (dir.isEmpty()) return false
        val sessionDir = normalize(session.directory)
        return sessionDir == dir || sessionDir.startsWith("$dir/")
    }

    fun pick(lane: LaneRecord, sessions: List<DashSession>): DashSession? {
        val ids = listOfNotNull(sessionID(lane.activity_session), sessionID(lane.owner))
        ids.forEach { id -> sessions.firstOrNull { it.id == id }?.let { return it } }
        return sessions.filter { inLane(lane, it) }.maxByOrNull { it.updated }
    }

    // The sessions that count towards "busy": the picked one, plus any anchored in the lane.
    fun anchored(lane: LaneRecord, sessions: List<DashSession>, own: DashSession?): List<DashSession> =
        (listOfNotNull(own) + sessions.filter { inLane(lane, it) }).distinctBy { it.id }

    fun status(lane: LaneRecord, own: DashSession?, anchored: List<DashSession>): String = when {
        anchored.any { it.live == "busy" } -> "busy"
        own != null && own.live == "busy" -> "busy"
        lane.status == "parked" || lane.activity.startsWith("parked") -> "parked"
        // Provisional only when the lane record has never named a session.
        own == null && sessionID(lane.owner) == null && sessionID(lane.activity_session) == null && !lane.owner.startsWith("wingman:") -> "starting"
        // Recorded session not in the loaded page: we do not know; show last activity, not "starting".
        own == null -> "unknown"
        else -> "idle"
    }
}
