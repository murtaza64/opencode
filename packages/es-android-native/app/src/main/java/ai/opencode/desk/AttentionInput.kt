package ai.opencode.desk

import ai.opencode.desk.model.AttentionOption
import ai.opencode.desk.model.AttentionRecord
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ai.opencode.desk.model.OptionInput
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// Client side of the attention option-input contract (es-attention.md): what the human must
// supply for the selected option, whether the draft is sendable, and the `input_value` to send.
// The ledger re-validates everything; this only keeps the Send button honest.
object AttentionInput {
    // Draft value typed/picked for the selected option: text, one id, or ids in pick order.
    data class Draft(val text: String = "", val picks: List<String> = emptyList())

    val KNOWN = setOf("text", "choice", "multi")

    fun sendable(option: AttentionOption?) = option?.input?.let { it.kind in KNOWN } ?: true

    // Reason Send must stay disabled, or null when the draft satisfies the option.
    fun blocker(option: AttentionOption?, draft: Draft): String? {
        val input = option?.input ?: return null
        return when (input.kind) {
            "text" -> when {
                draft.text.isBlank() -> if (input.required) "${input.label} is required" else null
                draft.text.length > 2000 -> "${input.label} must be 2000 characters or fewer"
                else -> null
            }
            "choice" -> when {
                draft.picks.isEmpty() -> if (input.required) "Pick one ${input.label.lowercase()}" else null
                draft.picks.size > 1 || draft.picks.first() !in input.choices.map { it.id } -> "Pick one offered ${input.label.lowercase()}"
                else -> null
            }
            "multi" -> {
                val limit = input.max ?: input.choices.size
                when {
                    draft.picks.isEmpty() -> if (input.required) "Pick at least one ${input.label.lowercase()}" else null
                    draft.picks.size > limit -> "Pick at most $limit"
                    draft.picks.distinct().size != draft.picks.size -> "Duplicate pick"
                    draft.picks.any { it !in input.choices.map { c -> c.id } } -> "Pick only offered ${input.label.lowercase()}"
                    else -> null
                }
            }
            else -> "This option needs a newer app; answer in the source thread"
        }
    }

    // `input_value` for the answer command, or null when the option has no input or nothing was supplied.
    fun value(option: AttentionOption?, draft: Draft): JsonElement? {
        val input = option?.input ?: return null
        return when (input.kind) {
            "text" -> draft.text.takeIf { it.isNotBlank() }?.let { JsonPrimitive(it) }
            "choice" -> draft.picks.firstOrNull()?.let { JsonPrimitive(it) }
            "multi" -> draft.picks.takeIf { it.isNotEmpty() }?.let { JsonArray(it.map(::JsonPrimitive)) }
            else -> null
        }
    }

    // Human-readable rendering of a stored answer.input_value, using the option's labels.
    fun render(input: OptionInput?, value: JsonElement?): String? {
        if (value == null) return null
        val labels = input?.choices?.associate { it.id to it.label }.orEmpty()
        return when (value) {
            is JsonArray -> value.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull }.joinToString(", ") { labels[it] ?: it }
            is JsonPrimitive -> value.contentOrNull?.let { labels[it] ?: it }
            else -> value.toString()
        }
    }

    // The answer command body (es-attention.md): text, optional choice_id, input_value only
    // when the selected option declares input and a value was supplied. The same draft and
    // commandID always produce the same body, which is what makes a retry after a lost
    // response safe (the ledger returns the original result for an identical command).
    fun answerBody(record: AttentionRecord, choice: String?, note: String, draft: Draft, commandID: String): JsonObject {
        val option = record.options.firstOrNull { it.id == choice }
        return buildJsonObject {
            put("command_id", commandID)
            put("expected_revision", record.revision)
            put("action", "answer")
            put("text", note.ifBlank { option?.label ?: "" })
            if (choice != null) put("choice_id", choice)
            value(option, draft)?.let { put("input_value", it) }
        }
    }

    // How a failed send reads to the human. 4xx is a definite refusal (draft kept, same
    // command id); anything else (timeout, reset, 5xx, lost response) is "not confirmed":
    // the ledger may have committed it, and the identical retry is safe either way.
    sealed interface Outcome {
        data class Refused(val reason: String) : Outcome
        data class Unconfirmed(val reason: String) : Outcome
    }

    fun outcome(error: Throwable): Outcome = when {
        error is ai.opencode.desk.net.GatewayError && error.code in 400..499 -> Outcome.Refused(ledgerError(error.body, error.message ?: "HTTP ${error.code}"))
        else -> Outcome.Unconfirmed(error.message?.take(120) ?: error.javaClass.simpleName)
    }

    // The ledger's own words from a 4xx body `{error: "..."}`; falls back to the raw body.
    fun ledgerError(body: String, fallback: String): String {
        val parsed = runCatching { ai.opencode.desk.net.json.parseToJsonElement(body) as? JsonObject }.getOrNull()
        // JSON without an `error` field is not something to show the human; keep the HTTP line.
        if (parsed != null) return (parsed["error"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: fallback
        return body.trim().takeIf { it.isNotBlank() && it.length < 300 } ?: fallback
    }
}
