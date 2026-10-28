package ai.opencode.desk

import ai.opencode.desk.model.StateResponse

// The Agents list from one editspace's /es/api/state: one row per lane (joined to its owner
// session by id, see Anchors) plus one row per lane-less session thread, so a session that has
// no lane record (kind=session, no lanes[]) is still listed and openable. Pure: testable on
// the exact Mini state sample.
object Agents {
    fun derive(es: String, state: StateResponse): List<Agent> {
        val all = state.threads.flatMap { it.sessions } + state.sessions
        val fromLanes = state.threads.flatMap { thread ->
            thread.lanes.map { lane ->
                val head = Anchors.pick(lane, all)
                val sessions = Anchors.anchored(lane, all, head).sortedByDescending { it.updated }
                Agent(
                    key = "$es/${lane.lane}",
                    editspace = es,
                    lane = lane.lane,
                    title = thread.title.ifBlank { lane.lane },
                    description = thread.description,
                    status = Anchors.status(lane, head, sessions),
                    activity = lane.activity.ifBlank { head?.title?.takeIf { it != thread.title } ?: lane.lane },
                    activityAt = parseIso(lane.activity_at) ?: head?.updated?.toLong() ?: 0L,
                    issue = lane.issue,
                    session = head,
                    sessions = sessions,
                    owner = lane.owner,
                )
            }
        }
        val claimed = fromLanes.flatMap { a -> a.sessions.map { it.id } + listOfNotNull(a.session?.id) }.toSet()
        // Lane-less threads: each session is its own row, keyed by session id (lane = "" so pins
        // and routes use the session form).
        val loose = state.threads.filter { it.lanes.isEmpty() }.flatMap { thread ->
            thread.sessions.filter { it.id !in claimed }.map { session ->
                Agent(
                    key = "$es#${session.id}",
                    editspace = es,
                    lane = "",
                    title = session.title.ifBlank { thread.title }.ifBlank { session.id },
                    description = thread.description,
                    status = if (session.live == "busy") "busy" else "idle",
                    activity = thread.title.takeIf { it.isNotBlank() && it != session.title }.orEmpty(),
                    activityAt = session.updated.toLong(),
                    issue = "",
                    session = session,
                    sessions = listOf(session),
                    owner = session.id,
                )
            }
        }
        return fromLanes + loose
    }
}
