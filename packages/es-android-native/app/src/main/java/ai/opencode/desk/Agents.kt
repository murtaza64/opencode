package ai.opencode.desk

import ai.opencode.desk.model.DashSession
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
                    title = displayTitle(thread.title, lane.lane, head, sessions),
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

    // The thread title is the dashboard's display name. After a rollover it can still be an
    // older session's title; when it names a non-head session and not the head, the head's
    // own title is the current display name.
    private fun displayTitle(thread: String, lane: String, head: DashSession?, sessions: List<DashSession>): String {
        if (thread.isBlank()) return head?.title?.ifBlank { null } ?: lane
        val headTitle = head?.title.orEmpty()
        val stale = headTitle.isNotBlank() && headTitle != thread && sessions.any { it.id != head?.id && it.title == thread }
        return if (stale) headTitle else thread
    }

    fun historyRow(agents: List<Agent>, key: String): Agent? {
        val es = key.substringBefore('#', "")
        val id = key.substringAfter('#', "")
        if (es.isBlank() || id.isBlank()) return null
        val parent = agents.firstOrNull { it.editspace == es && it.history.any { s -> s.id == id } } ?: return null
        val session = parent.history.first { it.id == id }
        return parent.copy(key = key, lane = "", title = session.title.ifBlank { id }, status = if (session.live == "busy") "busy" else "idle",
            activity = "earlier session of ${parent.title}", activityAt = session.updated.toLong(), session = session, sessions = listOf(session), owner = session.id)
    }

    // Agents search (AND-W5): case-insensitive match on title, lane, project (editspace),
    // host owner, and any anchored session id (prefix, with or without "ses_"). Pure: never
    // touches the open conversation or drafts.
    fun search(agents: List<Agent>, query: String): List<Agent> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return agents
        return agents.filter { a ->
            a.title.lowercase().contains(q) || a.lane.lowercase().contains(q) || a.editspace.lowercase().contains(q) ||
                a.owner.lowercase().contains(q) || a.activity.lowercase().contains(q) ||
                a.sessions.any { it.id.lowercase().startsWith(q) || it.id.removePrefix("ses_").lowercase().startsWith(q.removePrefix("ses_")) }
        }
    }
}
