package ai.opencode.desk

// Port of inbox-push `proto/reconcile.py` (the reference shared with Editspace.app). Takes one
// host's actionable items (durable attention records + Core permission/question requests) and
// the device's last-posted ledger, and returns post/update/cancel actions keyed by a stable tag.
// Pure: no network, no platform calls. The same tag from every source (SSE nudge, poll, resume)
// collapses duplicates into one replace via NotificationManager.notify(tag, id).
object Reconciler {
    const val STALLED_MS = 4L * 60 * 60 * 1000

    data class Record(
        val editspace: String, val id: String, val revision: Int, val title: String, val status: String,
        val contentRevision: Int? = null, val deliveryState: String? = null, val answeredAt: Long? = null,
    )

    data class Request(val kind: String, val editspace: String, val id: String, val session: String?, val title: String)

    data class Item(val kind: String, val editspace: String, val id: String, val revision: Int, val title: String, val session: String? = null)

    sealed interface Action {
        val tag: String
        data class Post(override val tag: String, val item: Item) : Action
        data class Update(override val tag: String, val item: Item) : Action
        data class Cancel(override val tag: String) : Action
    }

    data class Result(val actions: List<Action>, val ledger: Map<String, Int>)

    fun reconcile(origin: String, attention: List<Record>, requests: List<Request>, ledger: Map<String, Int>, now: Long = 0): Result {
        val current = linkedMapOf<String, Pair<Int, Item>>()
        attention.forEach { r ->
            val base = "$origin|${r.editspace}|att:${r.id}"
            // An answer that cannot reach its agent needs the human again.
            if (r.deliveryState == "blocked" && (r.status == "answered" || r.status == "decided"))
                current["$base:blocked"] = 0 to Item("delivery-blocked", r.editspace, r.id, r.revision, r.title)
            // Answered but not resolved by the agent within 4 h: alert once, cleared by resolve.
            if (r.status == "answered" && r.answeredAt != null && now - r.answeredAt > STALLED_MS)
                current["$base:stalled"] = 0 to Item("stalled", r.editspace, r.id, r.revision, r.title)
            if (r.status != "open") return@forEach
            // Alert on entering open or on a content change; delivery/snooze bookkeeping bumps
            // `revision` without changing what the human must decide, so it never re-alerts.
            current[base] = (r.contentRevision ?: r.revision) to Item("decision", r.editspace, r.id, r.revision, r.title)
        }
        requests.forEach { q ->
            // Idle/completion entries are not actionable and never notify.
            if (q.kind != "permission" && q.kind != "question") return@forEach
            current["$origin|${q.editspace}|req:${q.id}"] = 0 to Item(q.kind, q.editspace, q.id, 0, q.title, q.session)
        }
        val actions = mutableListOf<Action>()
        current.toSortedMap().forEach { (tag, entry) ->
            val (stamp, item) = entry
            val previous = ledger[tag]
            if (previous == null) actions += Action.Post(tag, item)
            else if (previous < stamp) actions += Action.Update(tag, item)
        }
        // Only this origin's tags are cancelled; another host's ledger entries are never touched.
        ledger.keys.sorted().forEach { tag -> if (tag.startsWith("$origin|") && tag !in current) actions += Action.Cancel(tag) }
        val next = ledger.filterKeys { !it.startsWith("$origin|") } + current.mapValues { it.value.first }
        return Result(actions, next)
    }

    // Parses a tag back into its parts for deep links: origin|editspace|att:<id>[:suffix] / req:<id>.
    data class Target(val origin: String, val editspace: String, val kind: String, val id: String)

    fun target(tag: String): Target? {
        val bar1 = tag.indexOf('|'); if (bar1 < 0) return null
        val bar2 = tag.indexOf('|', bar1 + 1); if (bar2 < 0) return null
        val origin = tag.substring(0, bar1); val editspace = tag.substring(bar1 + 1, bar2); val rest = tag.substring(bar2 + 1)
        val kind = rest.substringBefore(':'); val id = rest.substringAfter(':').substringBefore(':')
        if (kind != "att" && kind != "req") return null
        return Target(origin, editspace, if (kind == "att") "attention" else "request", id)
    }
}
