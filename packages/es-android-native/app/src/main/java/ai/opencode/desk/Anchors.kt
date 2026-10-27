package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.LaneRecord

// Which session a lane row stands for. A lane's `owner` can be a session anchored outside
// the lane (a provisional or delegating parent) until the worker starts; that session must
// not be shown as the lane, or steering it would steer the parent.
object Anchors {
    fun inLane(lane: LaneRecord, session: DashSession): Boolean {
        val dir = lane.dir.trimEnd('/')
        if (dir.isEmpty()) return false
        val sessionDir = session.directory.trimEnd('/')
        return sessionDir == dir || sessionDir.startsWith("$dir/")
    }

    // The lane's own session: the recorded activity/owner session when it is anchored in the
    // lane, else the newest session anchored there. Null means nothing has started in the lane yet.
    fun pick(lane: LaneRecord, sessions: List<DashSession>): DashSession? {
        val anchored = sessions.filter { inLane(lane, it) }.sortedByDescending { it.updated }
        return anchored.firstOrNull { it.id == lane.activity_session || it.id == lane.owner } ?: anchored.firstOrNull()
    }

    fun status(lane: LaneRecord, own: DashSession?, anchored: List<DashSession>): String = when {
        own == null -> "starting"
        anchored.any { it.live == "busy" } -> "busy"
        lane.status == "parked" || lane.activity.startsWith("parked") -> "parked"
        else -> "idle"
    }
}
