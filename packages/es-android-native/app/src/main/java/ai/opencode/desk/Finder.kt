package ai.opencode.desk

// Findability (SPEC-0.1.19-FINDABILITY): sort, filter chips and the Home "Your conversations"
// ranking, as pure functions over the derived Agent rows. The query/sort/chips are a view over
// the list only; nothing here touches the open conversation or drafts.
object Finder {
    enum class Sort(val label: String) { Recent("Recent activity"), MyMessage("My last message"), Name("Name"), Status("Status") }
    enum class Chip(val label: String) { Pinned("Pinned"), Working("Working"), NeedsYou("Needs you"), Messaged("Messaged by me") }

    data class Signals(
        val pinned: Set<String> = emptySet(),        // agent keys
        val needsYou: Set<String> = emptySet(),      // agent keys with open attention
        val lastSent: Map<String, Long> = emptyMap(), // session id -> ms of my last human message
        val opened: Map<String, Long> = emptyMap(),   // agent key -> ms last opened on this device
    )

    fun lastSent(agent: Agent, signals: Signals): Long = agent.sessions.maxOfOrNull { signals.lastSent[it.id] ?: 0L } ?: 0L

    // Chips are offered only when some row would match them.
    fun availableChips(agents: List<Agent>, signals: Signals): List<Chip> = Chip.entries.filter { chip -> agents.any { matches(it, chip, signals) } }

    fun matches(agent: Agent, chip: Chip, signals: Signals): Boolean = when (chip) {
        Chip.Pinned -> agent.key in signals.pinned
        Chip.Working -> agent.busy
        Chip.NeedsYou -> agent.key in signals.needsYou
        Chip.Messaged -> lastSent(agent, signals) > 0L
    }

    private val statusRank = listOf("busy", "starting", "unknown", "idle", "parked")

    fun apply(agents: List<Agent>, query: String, sort: Sort, chips: Set<Chip>, signals: Signals): List<Agent> {
        val filtered = Agents.search(agents, query).filter { a -> chips.all { matches(a, it, signals) } }
        return when (sort) {
            Sort.Recent -> filtered.sortedByDescending { it.activityAt }
            Sort.MyMessage -> filtered.sortedWith(compareByDescending<Agent> { lastSent(it, signals) }.thenByDescending { it.activityAt })
            Sort.Name -> filtered.sortedBy { it.title.lowercase() }
            Sort.Status -> filtered.sortedWith(compareBy<Agent> { statusRank.indexOf(it.status).let { i -> if (i < 0) statusRank.size else i } }.thenByDescending { it.activityAt })
        }
    }

    // Home "Your conversations": agents ranked by my last human message to them. Until that data
    // exists, fall back to pinned + recently opened on this device, labelled as such.
    data class Conversations(val agents: List<Agent>, val fallback: Boolean)

    fun conversations(agents: List<Agent>, signals: Signals, limit: Int = 5): Conversations {
        val messaged = agents.filter { lastSent(it, signals) > 0L }.sortedByDescending { lastSent(it, signals) }
        if (messaged.isNotEmpty()) return Conversations(messaged.take(limit), fallback = false)
        val local = agents.filter { it.key in signals.pinned || it.key in signals.opened }
            .sortedByDescending { maxOf(signals.opened[it.key] ?: 0L, if (it.key in signals.pinned) 1L else 0L) }
        return Conversations(local.take(limit), fallback = true)
    }
}
