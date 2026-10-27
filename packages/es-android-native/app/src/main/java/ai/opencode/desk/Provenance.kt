package ai.opencode.desk

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// Who put a user-role message into the session. The human's own words have no `source`;
// everything else is lower-trust input the agent received and must read as such on the
// phone (never in the human's blue bubble). The server types only editspace mail today
// (schema session-mail-source.ts); a later union member lands in `Other` with its fields
// until this file learns its shape.
sealed interface Provenance {
    val type: String

    data object Human : Provenance {
        override val type = "human"
    }

    data class Mail(
        val id: String,
        val sender: String,
        val recipient: String,
        val kind: String?,
        val inReplyTo: String?,
        val senderSession: String?,
        val relationship: String?,
        val originRun: String?,
        val supersedes: String?,
    ) : Provenance {
        override val type = "editspace-mail"
    }

    // Peer or bridge input (never an approval); a claimed author is a claim, not a stamp.
    data class Integration(val name: String, val request: String?, val claimedAuthor: String?) : Provenance {
        override val type = "integration"
    }

    // Runtime control input: recovery, nudge, spawn, resume, handoff, workflow, curation.
    data class System(val kind: String, val actor: String?) : Provenance {
        override val type = "system"
    }

    // Server-stamped human input; Core refuses this type from request bodies.
    data class Operator(val channel: String?) : Provenance {
        override val type = "operator"
    }

    data class Other(override val type: String, val fields: Map<String, String>) : Provenance

    companion object {
        private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

        fun of(source: JsonObject?): Provenance {
            if (source == null) return Human
            val type = source.str("type") ?: return Other("unknown", source.strings())
            return when (type) {
                "editspace-mail" -> Mail(
                    id = source.str("id").orEmpty(),
                    sender = source.str("sender").orEmpty(),
                    recipient = source.str("recipient").orEmpty(),
                    kind = source.str("kind"),
                    inReplyTo = source.str("in_reply_to"),
                    senderSession = source.str("senderSession"),
                    relationship = source.str("relationship"),
                    originRun = source.str("originRun"),
                    supersedes = source.str("supersedes"),
                )
                "integration" -> Integration(source.str("name").orEmpty(), source.str("request"), source.str("claimedAuthor"))
                "system" -> System(source.str("kind") ?: "system", source.str("actor"))
                "operator" -> Operator(source.str("channel"))
                else -> Other(type, source.strings() - "type")
            }
        }

        private fun JsonObject.strings() = entries.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { key to it } }.toMap()
    }
}

// One-line header for a sourced message, e.g. "mail · es-android → android-native · task".
fun Provenance.headline(): String? = when (this) {
    Provenance.Human -> null
    is Provenance.Mail -> listOfNotNull("mail", listOf(sender, recipient).filter { it.isNotBlank() }.joinToString(" → ").ifBlank { null }, kind).joinToString(" · ")
    is Provenance.Integration -> listOfNotNull("integration", name.ifBlank { null }, claimedAuthor?.let { "claims: $it" }).joinToString(" · ")
    is Provenance.System -> listOfNotNull("system", kind, actor).joinToString(" · ")
    is Provenance.Operator -> listOfNotNull("Murtaza", channel?.let { "via $it" }).joinToString(" · ")
    is Provenance.Other -> listOfNotNull(type, fields["sender"] ?: fields["from"], fields["kind"]).joinToString(" · ")
}

// Secondary detail shown on tap: ids and lineage, never the body.
fun Provenance.detail(): String? = when (this) {
    Provenance.Human -> null
    is Provenance.Mail -> listOfNotNull(
        id.takeIf { it.isNotBlank() }?.let { "id $it" },
        inReplyTo?.let { "reply to $it" },
        supersedes?.let { "supersedes $it" },
        relationship?.let { "relationship $it" },
        senderSession?.let { "sender session $it" },
        originRun?.let { "origin run $it" },
    ).joinToString(" · ").ifBlank { null }
    is Provenance.Integration -> listOfNotNull(request?.let { "request $it" }, claimedAuthor?.let { "claims $it (unverified)" }).joinToString(" · ").ifBlank { null }
    is Provenance.System -> actor?.let { "actor $it" }
    is Provenance.Operator -> channel?.let { "channel $it" }
    is Provenance.Other -> fields.entries.joinToString(" · ") { "${it.key} ${it.value}" }.ifBlank { null }
}
