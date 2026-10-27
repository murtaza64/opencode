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

    // Tool-only messages fold into one run; a run ends at any chip, prose or bubble. Chips are
    // never grouped with tools or with each other (ux-feel default: each mail separate).
    fun build(placed: List<Authorship.Placed>): List<Item> {
        val out = mutableListOf<Item>()
        var run = mutableListOf<Unit.Tools>()
        fun flush() {
            if (run.isEmpty()) return
            if (run.size >= 2) out += Item.ToolRun(run.toList()) else out += Item.Single(run.single())
            run = mutableListOf()
        }
        val seen = mutableSetOf<String>()
        placed.map(::unit).forEach { unit ->
            when (unit) {
                is Unit.Tools -> run += unit
                is Unit.Chip -> { flush(); if (seen.add(unit.key)) out += Item.Single(unit) }
                is Unit.Reply, is Unit.Bubble -> { flush(); out += Item.Single(unit) }
            }
        }
        flush()
        return out
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
