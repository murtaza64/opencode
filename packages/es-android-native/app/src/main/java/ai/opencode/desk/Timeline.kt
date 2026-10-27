package ai.opencode.desk

import ai.opencode.desk.model.MessageWithParts

// Turns a placed transcript into what the phone draws (CHAT-PARTS §2): typed peer input
// becomes a chip; consecutive tool-only assistant messages fold into one tool run; prose,
// You/Operator/System/Unattributed bubbles and mail chips are boundaries a run never crosses.
// Classification uses only the typed source (Authorship), never the body text.
object Timeline {
    enum class Direction { Incoming, Outgoing, Unknown }

    sealed interface Unit {
        val message: MessageWithParts

        // Typed peer input: a chip. `key` is the mail id when present so a receipt and its
        // projected message, or a paged duplicate, count once.
        data class Chip(override val message: MessageWithParts, val author: Author, val provenance: Provenance, val key: String, val direction: Direction) : Unit

        // Assistant message with tool calls and no prose.
        data class Tools(override val message: MessageWithParts, val count: Int) : Unit

        // Assistant prose (with any tools inline): a boundary.
        data class Reply(override val message: MessageWithParts) : Unit

        // You / Operator / Unattributed / System: a boundary, drawn as a bubble or card.
        data class Bubble(override val message: MessageWithParts, val author: Author?, val first: Boolean) : Unit
    }

    sealed interface Item {
        data class Single(val unit: Unit) : Item

        // Consecutive typed incoming mail/integration on the incoming side:
        // "N mail · <latest party> · <actionable status>", expandable to the individual chips.
        data class IncomingStrip(val chips: List<Unit.Chip>) : Item {
            val count get() = chips.distinctBy { it.key }.size
            val latest get() = chips.last()
            val party get() = chipLine(latest).party
            // The most recent actionable status across the strip, if any.
            val status get() = chips.asReversed().firstNotNullOfOrNull { chipLine(it).status }
            val label get() = listOfNotNull("$count mail", party, status).joinToString(" · ")
        }

        // Consecutive tool-only messages: "N tools · <most significant action>".
        data class ToolRun(val units: List<Unit.Tools>) : Item {
            val count get() = units.sumOf { it.count }
            val live get() = units.any { t -> t.message.parts.any { it.type == "tool" && (it.state?.status == "running" || it.state?.status == "pending") } }
            val failed get() = units.any { t -> t.message.parts.any { it.type == "tool" && it.state?.status == "error" } }
            val parts get() = units.flatMap { it.message.parts.filter { p -> p.type == "tool" } }
            // The action a reader most wants to know about: a failure, else the running call, else the last write-ish call, else the last call.
            val headline: String get() {
                val rows = parts.map(ToolRows::row)
                val pick = rows.lastOrNull { it.failed } ?: rows.lastOrNull { it.live } ?: rows.lastOrNull { it.tool in WRITES } ?: rows.lastOrNull()
                return pick?.let { "${it.tool} ${it.primary}".trim() }.orEmpty()
            }
        }
    }

    private val WRITES = setOf("edit", "write", "bash", "task", "todowrite")

    // Host a chip came from: the part after '@' in the sender or sender session, else local.
    fun host(chip: Unit.Chip): String = when (val p = chip.provenance) {
        is Provenance.Mail -> (p.senderSession?.substringAfter('@', "") ?: "").ifBlank { p.sender.substringAfter('@', "") }.ifBlank { "local" }
        else -> "local"
    }

    fun mailID(message: MessageWithParts): String? = (Provenance.of(message.info.source) as? Provenance.Mail)?.id?.takeIf { it.isNotBlank() }

    // Direction by verified source only: a typed user-role message in this session is mail this
    // session received. Outgoing mail has no typed record in the transcript today (it is an
    // `es mail send` tool call) so nothing is ever classified outgoing from body text.
    fun direction(provenance: Provenance): Direction = when (provenance) {
        is Provenance.Mail, is Provenance.Integration -> Direction.Incoming
        else -> Direction.Unknown
    }

    fun unit(placed: Authorship.Placed): Unit {
        val message = placed.message
        if (message.info.role != "user") {
            val prose = message.parts.any { it.type == "text" && !it.text.isNullOrBlank() }
            val tools = message.parts.count { it.type == "tool" }
            return if (!prose && tools > 0) Unit.Tools(message, tools) else Unit.Reply(message)
        }
        return when (val author = placed.author) {
            is Author.Agent, is Author.Integration -> {
                val provenance = Provenance.of(message.info.source)
                Unit.Chip(message, author, provenance, mailID(message) ?: message.info.id, direction(provenance))
            }
            else -> Unit.Bubble(message, author, placed.first)
        }
    }

    // Grouping by same side + source class. Agent side: consecutive tool-only messages fold
    // into one run. Incoming side: consecutive typed incoming mail/integration fold into one
    // strip. A run never takes mail and a strip never takes tools; both end at You/Operator,
    // prose, Unattributed/System, a direction change or a host change. Mail-id dedup first, so
    // counts are distinct ids.
    fun build(placed: List<Authorship.Placed>): List<Item> {
        val out = mutableListOf<Item>()
        var tools = mutableListOf<Unit.Tools>()
        var chips = mutableListOf<Unit.Chip>()
        fun flushTools() { if (tools.isEmpty()) return; out += if (tools.size >= 2) Item.ToolRun(tools.toList()) else Item.Single(tools.single()); tools = mutableListOf() }
        fun flushChips() { if (chips.isEmpty()) return; out += if (chips.size >= 2) Item.IncomingStrip(chips.toList()) else Item.Single(chips.single()); chips = mutableListOf() }
        val seen = mutableSetOf<String>()
        placed.map(::unit).forEach { unit ->
            when (unit) {
                is Unit.Tools -> { flushChips(); tools += unit }
                is Unit.Chip -> {
                    flushTools()
                    if (!seen.add(unit.key)) return@forEach
                    val last = chips.lastOrNull()
                    if (last != null && (last.direction != unit.direction || host(last) != host(unit) || unit.direction != Direction.Incoming)) flushChips()
                    if (unit.direction == Direction.Incoming) chips += unit else { flushChips(); out += Item.Single(unit) }
                }
                is Unit.Reply, is Unit.Bubble -> { flushTools(); flushChips(); out += Item.Single(unit) }
            }
        }
        flushTools(); flushChips()
        return out
    }

    // Stable identity of a group: the id of its first message. Expansion state is keyed by this,
    // never by position, so a regroup that keeps the same first member keeps its expanded state.
    fun key(item: Item): String = when (item) {
        is Item.ToolRun -> "run-" + item.units.first().message.info.id
        is Item.IncomingStrip -> "strip-" + item.chips.first().message.info.id
        is Item.Single -> item.unit.message.info.id
    }

    // While the visible agent run is active nothing regroups: items already placed keep their
    // groups, and every new part is appended as its own chip with a stable key (never
    // reparented, reordered or collapsed into a trailing group). Grouping is finalized once,
    // by the caller, when the session status is actually idle/completed.
    fun buildFrozen(previous: List<Item>?, placed: List<Authorship.Placed>, running: Boolean): List<Item> {
        val fresh = build(placed)
        if (!running || previous.isNullOrEmpty()) return fresh
        val units = placed.map(::unit)
        val present = units.map { it.message.info.id }.toSet()
        val seen = mutableSetOf<String>()
        // Groups keep only while every member is still present; survivors of a broken group
        // become singles in their original order, ahead of anything new.
        val kept = mutableListOf<Item>()
        previous.forEach { item ->
            val alive = members(item).filter { it.message.info.id in present }
            if (alive.size == members(item).size) kept += item
            else alive.forEach { m -> kept += Item.Single(units.first { it.message.info.id == m.message.info.id }) }
        }
        kept.flatMap(::members).forEach { if (it is Unit.Chip) seen += it.key }
        val known = kept.flatMap(::members).map { it.message.info.id }.toSet()
        units.filter { it.message.info.id !in known }.forEach { unit ->
            if (unit is Unit.Chip && !seen.add(unit.key)) return@forEach
            kept += Item.Single(unit)
        }
        return kept
    }

    // Whether a status transition finalizes grouping: only a real idle/completed/error status
    // does; reconnecting, unknown and retry do not, and timers never call this.
    fun finalizes(previous: String?, current: String?): Boolean =
        previous == "busy" && (current == "idle" || current == "error" || current == "completed")

    // Expanded state is keyed by part/message ids. A group opens expanded when any member
    // was expanded before finalization.
    fun inheritsExpanded(item: Item, expanded: Set<String>): Boolean = members(item).any { it.message.info.id in expanded }

    fun members(item: Item): List<Unit> = when (item) {
        is Item.ToolRun -> item.units
        is Item.IncomingStrip -> item.chips
        is Item.Single -> listOf(item.unit)
    }

    // Pending receipts admitted from mail that already appear in the transcript are not drawn twice.
    fun dedupPending(pending: List<Pending>, messages: List<MessageWithParts>): List<Pending> {
        val ids = messages.mapNotNull(::mailID).toSet()
        return pending.filter { it.mailID == null || it.mailID !in ids }
    }

    // The collapsed chip line (CHAT-PARTS §2): other party · purpose · actionable status only.
    // No kind duplicate, no timestamps, no body, no delivery chatter.
    data class ChipLine(val party: String, val purpose: String?, val status: String?, val crossHost: Boolean) {
        val text get() = listOfNotNull(party, purpose, status).joinToString(" · ")
    }

    private val ACTIONABLE_KINDS = setOf("question")

    fun chipLine(chip: Unit.Chip, subject: String? = null): ChipLine = when (val p = chip.provenance) {
        is Provenance.Mail -> ChipLine(
            party = if (p.sender.trim().lowercase() == "human") "human · unverified" else p.sender.ifBlank { "agent" },
            purpose = subject?.takeIf { it.isNotBlank() } ?: p.kind,
            status = if (p.kind in ACTIONABLE_KINDS) "Waiting for reply" else null,
            crossHost = p.sender.contains('@') || p.senderSession?.contains('@') == true,
        )
        is Provenance.Integration -> ChipLine(p.name.ifBlank { "integration" }, subject?.takeIf { it.isNotBlank() } ?: p.request, null, false)
        else -> ChipLine(chip.author.label, null, null, false)
    }

    // Pending outbox status is the only other collapsed status allowed, and only when actionable.
    fun pendingStatus(state: SendState): String? = when (state) {
        SendState.Sending -> "Sending"
        SendState.Failed -> "Failed"
        SendState.Uncertain -> "Not confirmed · retry safe"
        else -> null
    }
}
