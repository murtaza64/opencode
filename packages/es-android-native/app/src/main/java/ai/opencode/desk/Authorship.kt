package ai.opencode.desk

import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.Part
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// Who a user-role message is from, as the phone can prove it:
// - You: this phone sent it (its message id is in the phone's own sent ledger). Nothing else
//   is ever shown as Murtaza, including untyped messages and text that quotes an approval.
// - Agent: editspace mail from a peer (sender, kind, relationship such as "forwarded by X").
// - System: a typed non-mail source (recovery, resume, heartbeat, …) or a message whose text
//   parts are all synthetic (part.metadata.source), e.g. injected desk context.
// - Unattributed: no source and not ours, or a source type this app does not know yet.
sealed interface Author {
    val label: String
    val description: String

    data object You : Author {
        override val label = "you"
        override val description = "Sent from this phone"
    }

    data class Agent(val sender: String, val kind: String?, val relationship: String?) : Author {
        override val label get() = listOfNotNull(sender.ifBlank { "agent" }, kind, relationship).joinToString(" · ")
        override val description get() = "Mail from ${sender.ifBlank { "an agent" }}" + (kind?.let { ", $it" } ?: "") + (relationship?.let { ", $it" } ?: "")
    }

    data class System(val kind: String) : Author {
        override val label get() = "system · $kind"
        override val description get() = "System input: $kind"
    }

    data class Unattributed(val type: String?) : Author {
        override val label get() = if (type == null) "unattributed" else "unattributed · $type"
        override val description get() = if (type == null) "Input with no recorded source" else "Input from an unrecognised source type $type"
    }
}

object Authorship {
    val SYSTEM_KINDS = setOf("system", "recovery", "resume", "restart", "heartbeat", "compaction", "handoff", "subagent-return")

    private fun Part.synthetic() = (metadata?.get("source") as? JsonPrimitive)?.contentOrNull?.isNotBlank() == true

    fun of(message: MessageWithParts, mine: Set<String>): Author? {
        if (message.info.role != "user") return null
        if (message.info.id in mine) return Author.You
        return when (val source = Provenance.of(message.info.source)) {
            is Provenance.Mail -> Author.Agent(source.sender, source.kind, source.relationship)
            is Provenance.Other -> when {
                source.type in SYSTEM_KINDS -> Author.System(source.type)
                source.type == "unknown" -> Author.Unattributed(null)
                else -> Author.Unattributed(source.type)
            }
            Provenance.Human -> {
                val texts = message.parts.filter { it.type == "text" }
                if (texts.isNotEmpty() && texts.all { it.synthetic() }) Author.System("synthetic") else Author.Unattributed(null)
            }
        }
    }

    fun ofReceipt(receipt: InputReceipt, mineRequests: Set<String>): Author {
        if (receipt.requestID in mineRequests) return Author.You
        return when (val source = Provenance.of(receipt.source)) {
            is Provenance.Mail -> Author.Agent(source.sender, source.kind, source.relationship)
            is Provenance.Other -> if (source.type in SYSTEM_KINDS) Author.System(source.type) else Author.Unattributed(source.type.takeIf { it != "unknown" })
            Provenance.Human -> Author.Unattributed(null)
        }
    }

    // Consecutive messages coalesce under one header only when they share an author exactly;
    // assistant messages (author null) never coalesce with user input.
    data class Placed(val message: MessageWithParts, val author: Author?, val first: Boolean)

    fun place(messages: List<MessageWithParts>, mine: Set<String>): List<Placed> {
        var previous: Author? = null
        var previousUser = false
        return messages.map { message ->
            val author = of(message, mine)
            val user = message.info.role == "user"
            val first = !(user && previousUser && author == previous)
            previous = author
            previousUser = user
            Placed(message, author, first)
        }
    }
}
