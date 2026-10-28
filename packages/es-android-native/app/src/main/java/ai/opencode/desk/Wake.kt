package ai.opencode.desk

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

// Wake cues (CHAT-PARTS §4). Whether a mail woke its session comes only from the delivery
// evidence handoff-reliability records (admission observer + runtime receipt), never from text,
// "admitted" or "scheduled" alone. The dashboard computes `wake` in `wake_evidence`; when a
// payload carries only the raw observations the same rule is applied here.

@Serializable
data class WakeObservation(val outcome: String = "", val observedAt: Long? = null)

@Serializable
data class Delivery(
    val message_id: String = "",
    val recipient: String = "",
    val session: String? = null,
    val mode: String? = null,
    val state: String? = null,
    val request_id: String? = null,
    val error: String? = null,
    val host: String? = null,
    val presented_at: JsonElement? = null,
    val handled_at: JsonElement? = null,
    val wake: String? = null,
    val wake_observed_at: Long? = null,
    val presented_ms: Long? = null,
    val handled_ms: Long? = null,
    val wake_observations: List<WakeObservation> = emptyList(),
)

@Serializable
data class MailMessage(
    val id: String,
    val ts: String = "",
    val created_ms: Long? = null,
    val from: String = "",
    val to: String = "",
    val kind: String = "",
    val sender_session: String? = null,
    val deliveries: List<Delivery> = emptyList(),
)

@Serializable
data class MailResponse(val editspace: String = "", val lane: String = "", val messages: List<MailMessage> = emptyList())

@Serializable
data class WakeEvent(
    val id: String,
    val session: String = "",
    val host: String? = null,
    val cause: String = "",
    val recipient: String? = null,
    val at: Long? = null,
    val admission: String? = null,
    val outcome: String? = null,
    val covers: List<String> = emptyList(),
)

@Serializable
data class WakeEventsResponse(val events: List<WakeEvent> = emptyList())

enum class Wake { Caused, Joined, None, Unknown }

// Evidence as the chip shows it: the state plus the times the details expansion lists.
data class WakeEvidence(val wake: Wake, val observedAt: Long?, val presentedAt: Long?, val handledAt: Long?)

object WakeRules {
    private fun ms(value: JsonElement?): Long? = when (value) {
        null -> null
        is JsonPrimitive -> value.longOrNull ?: value.contentOrNull?.let { runCatching { java.time.Instant.parse(it.replace("Z", "+00:00").let { s -> if (s.endsWith("+00:00")) s.dropLast(6) + "Z" else s }).toEpochMilli() }.getOrNull() }
        else -> null
    }

    // Mirrors es_dashboard_mail.wake_evidence: caused = scheduled + presented; joined = coalesced;
    // none = not actionable; otherwise unknown.
    fun of(delivery: Delivery): WakeEvidence {
        val presented = delivery.presented_ms ?: ms(delivery.presented_at)
        val handled = delivery.handled_ms ?: ms(delivery.handled_at)
        val observed = delivery.wake_observed_at ?: delivery.wake_observations.mapNotNull { it.observedAt }.minOrNull()
        val wake = when (delivery.wake) {
            "caused" -> Wake.Caused
            "joined" -> Wake.Joined
            "none" -> Wake.None
            "unknown" -> Wake.Unknown
            else -> when {
                delivery.mode != "actionable" -> Wake.None
                delivery.wake_observations.any { it.outcome == "scheduled" } && presented != null -> Wake.Caused
                delivery.wake_observations.any { it.outcome == "coalesced" } -> Wake.Joined
                else -> Wake.Unknown
            }
        }
        return WakeEvidence(wake, observed, presented, handled)
    }

    // The evidence for one mail id as received by one session; null when nothing is recorded,
    // in which case the chip is unchanged.
    fun forMail(mail: List<MailMessage>, mailID: String, session: String?): WakeEvidence? {
        val message = mail.firstOrNull { it.id == mailID } ?: return null
        val delivery = message.deliveries.firstOrNull { session == null || it.session == session } ?: message.deliveries.firstOrNull() ?: return null
        return of(delivery)
    }

    // Accessible text per state; the glyph is drawn by the UI.
    fun description(wake: Wake, agent: String) = when (wake) {
        Wake.Caused -> "Woke $agent"
        Wake.Joined -> "Arrived while $agent was working"
        Wake.None -> "Recorded, did not wake"
        Wake.Unknown -> "Wake not confirmed"
    }

    // Marker row label for a wake event (markers are separate from the mail they cover).
    fun markerLabel(event: WakeEvent) = when (event.cause) {
        "passive-review" -> "Woke for passive review" + (event.covers.size.takeIf { it > 0 }?.let { " · $it mail" } ?: "")
        "resume" -> "Resumed"
        "recovery" -> "Recovered after restart"
        "handoff-kickoff", "handoff" -> "Started from handoff"
        else -> event.cause.ifBlank { "Woke" }
    }
}

// Timestamp details (CHAT-PARTS §5): recorded time, never the render clock; duration when known.
object Timestamps {
    fun format(recordedMs: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
        val t = java.time.Instant.ofEpochMilli(recordedMs).atZone(zone)
        val offset = t.offset.id.let { if (it == "Z") "UTC+0" else "UTC" + it.substringBefore(":").replace("+0", "+").replace("-0", "-") }
        return java.time.format.DateTimeFormatter.ofPattern("EEE d MMM, HH:mm:ss", java.util.Locale.ENGLISH).format(t) + " ($offset)"
    }

    fun details(recordedMs: Long, completedMs: Long? = null, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
        val base = format(recordedMs, zone)
        val duration = completedMs?.takeIf { it > recordedMs }?.let { (it - recordedMs + 500) / 1000 }
        return if (duration != null) "$base · $duration s" else base
    }
}
