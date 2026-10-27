package ai.opencode.desk

import ai.opencode.desk.model.InputReceipt

// What the phone knows about an input it sent, from the tap until the model has handled it.
// The states say exactly what has been proven: `Accepted` means the durable receipt exists,
// nothing more; `Presented` is the first state in which a model has seen the text.
enum class SendState { Sending, Accepted, Presented, Handled, Failed, Uncertain }

data class Pending(
    val requestID: String,
    val sessionID: String,
    val text: String,
    val delivery: String,
    val state: SendState,
    val error: String? = null,
    val messageID: String? = null,
    val createdAt: Long,
    val attempts: Int = 1,
    // Null for this phone's own sends; set for receipts admitted by someone else.
    val author: Author? = null,
    val images: Int = 0,
    // Mail id when the receipt was admitted from typed mail, for dedup against the transcript.
    val mailID: String? = null,
) {
    val retryable get() = state == SendState.Failed || state == SendState.Uncertain
    val done get() = state == SendState.Handled

    val label: String
        get() = (if (images > 0) "$images image${if (images == 1) "" else "s"} · " else "") + when (state) {
            SendState.Sending -> "sending…"
            // "queued" and "promoted" both mean the runtime holds it; never say the model saw it.
            SendState.Accepted -> if (delivery == "queue") "accepted · runs when idle" else "accepted · next safe boundary"
            SendState.Presented -> "seen by the agent"
            SendState.Handled -> "handled"
            SendState.Failed -> "failed · ${error ?: "rejected"}"
            SendState.Uncertain -> "not confirmed · retry is safe"
        }
}

object Outbox {
    fun fromReceipt(receipt: InputReceipt): SendState = when (receipt.state) {
        "pending", "promoted" -> SendState.Accepted
        "presented" -> SendState.Presented
        "handled" -> SendState.Handled
        else -> SendState.Handled
    }

    // Merges the phone's own sends with the server's receipts: a receipt proves acceptance
    // (also for an Uncertain send whose response was lost); a receipt that vanished after we
    // saw it accepted is treated as handled once its message is in the transcript, or dropped
    // if cancelled. Receipts the phone never sent (other clients) show as accepted.
    fun reconcile(mine: List<Pending>, receipts: List<InputReceipt>, transcript: Set<String>): List<Pending> {
        val byID = receipts.associateBy { it.requestID }
        val updated = mine.mapNotNull { item ->
            val receipt = byID[item.requestID]
            when {
                receipt?.state == "cancelled" -> null
                receipt != null -> item.copy(state = fromReceipt(receipt), messageID = receipt.messageID, error = null)
                item.state == SendState.Sending || item.retryable -> item
                item.messageID != null && item.messageID in transcript -> item.copy(state = SendState.Handled)
                // Accepted earlier, receipt gone, message not seen: the server moved on; stop showing it.
                else -> null
            }
        }
        val known = updated.map { it.requestID }.toSet()
        val foreign = receipts.filter { it.requestID !in known && it.state != "cancelled" && it.state != "handled" }.map {
            Pending(it.requestID, it.sessionID, it.text, it.delivery, fromReceipt(it), messageID = it.messageID, createdAt = it.timeCreated, author = Authorship.ofReceipt(it, known), mailID = (Provenance.of(it.source) as? Provenance.Mail)?.id?.takeIf { id -> id.isNotBlank() })
        }
        return (updated + foreign).sortedBy { it.createdAt }
    }

    // Visible rows: everything not yet handled, plus handled ones only until the transcript shows them.
    fun visible(items: List<Pending>, transcript: Set<String>) =
        items.filter { !it.done || (it.messageID != null && it.messageID !in transcript) }
}
