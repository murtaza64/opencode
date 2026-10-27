package ai.opencode.desk

import ai.opencode.desk.model.MessageWithParts

// Turns a placed transcript into what the phone draws: replies and bubbles stay as they are;
// typed peer input (mail, integration) becomes a collapsed chip; a run of chips and tool-only
// assistant activity between two replies folds into one activity strip, as Desktop does.
// Classification uses only the typed source (Authorship), never the body text.
object Timeline {
    sealed interface Unit {
        val message: MessageWithParts

        // Typed peer input: a chip. `key` is the mail id when present so a receipt and its
        // projected message, or a paged duplicate, count once.
        data class Chip(override val message: MessageWithParts, val author: Author, val provenance: Provenance, val key: String) : Unit

        // Assistant message with tool calls and no prose.
        data class Tools(override val message: MessageWithParts, val count: Int) : Unit

        // Assistant prose (with any tools inline): a boundary.
        data class Reply(override val message: MessageWithParts) : Unit

        // You / Operator / Unattributed / System: a boundary, drawn as a bubble or card.
        data class Bubble(override val message: MessageWithParts, val author: Author?, val first: Boolean) : Unit
    }

    sealed interface Item {
        data class Single(val unit: Unit) : Item
        data class Strip(val units: List<Unit>) : Item {
            val mail get() = units.filterIsInstance<Unit.Chip>().distinctBy { it.key }.size
            val tools get() = units.filterIsInstance<Unit.Tools>().sumOf { it.count }
            val live get() = units.filterIsInstance<Unit.Tools>().any { t -> t.message.parts.any { it.type == "tool" && (it.state?.status == "running" || it.state?.status == "pending") } }
            val label get() = listOfNotNull(mail.takeIf { it > 0 }?.let { "$it mail" }, tools.takeIf { it > 0 }?.let { "$it tool${if (it == 1) "" else "s"}" }).joinToString(" · ")
        }
    }

    fun mailID(message: MessageWithParts): String? = (Provenance.of(message.info.source) as? Provenance.Mail)?.id?.takeIf { it.isNotBlank() }

    fun unit(placed: Authorship.Placed): Unit {
        val message = placed.message
        if (message.info.role != "user") {
            val prose = message.parts.any { it.type == "text" && !it.text.isNullOrBlank() }
            val tools = message.parts.count { it.type == "tool" }
            return if (!prose && tools > 0) Unit.Tools(message, tools) else Unit.Reply(message)
        }
        return when (val author = placed.author) {
            is Author.Agent, is Author.Integration -> Unit.Chip(message, author, Provenance.of(message.info.source), mailID(message) ?: message.info.id)
            else -> Unit.Bubble(message, author, placed.first)
        }
    }

    // Groups runs of chips + tool-only activity that contain at least one chip; runs of tools
    // alone stay as individual messages (the existing tool rows). Boundaries end a run.
    fun build(placed: List<Authorship.Placed>): List<Item> {
        val units = placed.map(::unit)
        val out = mutableListOf<Item>()
        var run = mutableListOf<Unit>()
        fun flush() {
            if (run.isEmpty()) return
            if (run.size >= 2 && run.any { it is Unit.Chip }) out += Item.Strip(run.toList())
            else run.forEach { out += Item.Single(it) }
            run = mutableListOf()
        }
        // The same mail id appearing twice in one transcript (receipt projection + paging) draws once.
        val seen = mutableSetOf<String>()
        units.forEach { unit ->
            when (unit) {
                is Unit.Chip -> if (seen.add(unit.key)) run += unit
                is Unit.Tools -> run += unit
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
}
