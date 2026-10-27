package ai.opencode.desk

import ai.opencode.desk.model.InputReceipt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxTest {
    private fun mine(id: String, state: SendState, messageID: String? = null, at: Long = 1) =
        Pending(id, "ses_a", "text $id", "steer", state, messageID = messageID, createdAt = at)
    private fun receipt(id: String, state: String, messageID: String? = null, at: Long = 1) =
        InputReceipt(requestID = id, state = state, delivery = "steer", text = "text $id", sessionID = "ses_a", messageID = messageID, timeCreated = at)

    @Test
    fun receipt_states_never_claim_the_model_saw_a_queued_input() {
        assertEquals(SendState.Accepted, Outbox.fromReceipt(receipt("r", "pending")))
        assertEquals(SendState.Accepted, Outbox.fromReceipt(receipt("r", "promoted")))
        assertEquals(SendState.Presented, Outbox.fromReceipt(receipt("r", "presented")))
        assertEquals(SendState.Handled, Outbox.fromReceipt(receipt("r", "handled")))
        assertTrue(mine("r", SendState.Accepted).label.startsWith("accepted"))
        assertEquals("accepted · runs when idle", mine("r", SendState.Accepted).copy(delivery = "queue").label)
    }

    @Test
    fun a_receipt_proves_an_uncertain_send_was_admitted() {
        val out = Outbox.reconcile(listOf(mine("r1", SendState.Uncertain)), listOf(receipt("r1", "pending")), emptySet())
        assertEquals(SendState.Accepted, out.single().state)
        assertEquals(null, out.single().error)
    }

    @Test
    fun unconfirmed_and_failed_sends_survive_until_retried_or_discarded() {
        val out = Outbox.reconcile(listOf(mine("r1", SendState.Uncertain), mine("r2", SendState.Failed, at = 2), mine("r3", SendState.Sending, at = 3)), emptyList(), emptySet())
        assertEquals(listOf(SendState.Uncertain, SendState.Failed, SendState.Sending), out.map { it.state })
    }

    @Test
    fun cancelled_receipt_removes_the_row() {
        assertTrue(Outbox.reconcile(listOf(mine("r1", SendState.Accepted)), listOf(receipt("r1", "cancelled")), emptySet()).isEmpty())
    }

    @Test
    fun accepted_then_gone_becomes_handled_when_its_message_is_in_the_transcript() {
        val out = Outbox.reconcile(listOf(mine("r1", SendState.Presented, messageID = "msg_9")), emptyList(), setOf("msg_9"))
        assertEquals(SendState.Handled, out.single().state)
        assertTrue(Outbox.visible(out, setOf("msg_9")).isEmpty())
    }

    @Test
    fun accepted_then_gone_without_a_message_is_dropped() {
        assertTrue(Outbox.reconcile(listOf(mine("r1", SendState.Accepted)), emptyList(), emptySet()).isEmpty())
    }

    @Test
    fun receipts_from_other_clients_show_as_accepted_but_handled_ones_do_not() {
        val out = Outbox.reconcile(emptyList(), listOf(receipt("x1", "pending", at = 5), receipt("x2", "handled", at = 6)), emptySet())
        assertEquals(listOf("x1"), out.map { it.requestID })
        assertEquals(SendState.Accepted, out.single().state)
    }

    @Test
    fun rows_are_ordered_by_creation_and_handled_ones_hide_once_visible_in_transcript() {
        val out = Outbox.reconcile(listOf(mine("r2", SendState.Sending, at = 2), mine("r1", SendState.Sending, at = 1)), listOf(receipt("r1", "handled", messageID = "m1", at = 1)), setOf("m1"))
        assertEquals(listOf("r1", "r2"), out.map { it.requestID })
        assertEquals(listOf("r2"), Outbox.visible(out, setOf("m1")).map { it.requestID })
        assertEquals(listOf("r1", "r2"), Outbox.visible(out, emptySet()).map { it.requestID })
    }

    @Test
    fun retryable_states_are_exactly_failed_and_uncertain() {
        assertEquals(listOf(SendState.Failed, SendState.Uncertain), SendState.entries.filter { mine("r", it).retryable })
    }
}
