package ai.opencode.desk

import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.MessageInfo
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.Part
import ai.opencode.desk.model.SessionTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// android-lead#56 chat reliability (BUG06: Mini Core history/receipt reads may 500 after a write).
class ReliabilityTest {
    private val fake = object : KeyValue { val m = HashMap<String, String>(); override fun get(key: String) = m[key]; override fun put(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value } }
    private fun uncertain(id: String) = Pending(id, "ses_a", "hello", "steer", SendState.Uncertain, error = "HTTP 500", createdAt = 1)
    private fun receipt(id: String, messageID: String) = InputReceipt(requestID = id, state = "pending", delivery = "steer", text = "hello", sessionID = "ses_a", messageID = messageID, timeCreated = 1)
    private fun user(id: String) = MessageWithParts(MessageInfo(id = id, role = "user", source = null, time = SessionTime(created = 1)), listOf(Part(id = "p$id", type = "text", text = "hello")))

    @Test
    fun post_500_then_receipt_exists_confirms_without_a_second_post() {
        val plan = Outbox.retryPlan(uncertain("req-1"), listOf(receipt("req-1", "msg-1")))
        assertEquals(Outbox.Plan.Confirm(receipt("req-1", "msg-1")), plan)
    }

    @Test
    fun post_500_and_no_receipt_stays_not_confirmed_and_retries_the_same_request_id() {
        val item = uncertain("req-2")
        assertEquals("not confirmed · retry is safe", item.label)
        assertEquals(Outbox.Plan.Resend("req-2"), Outbox.retryPlan(item, emptyList()))
        assertEquals(Outbox.Plan.Resend("req-2"), Outbox.retryPlan(item.copy(state = SendState.Failed), listOf(receipt("other", "m"))))
    }

    @Test
    fun a_failed_receipt_read_never_drops_or_resets_outbox_rows() {
        val accepted = Pending("req-3", "ses_a", "hello", "steer", SendState.Accepted, messageID = "msg-3", createdAt = 1)
        val kept = Outbox.reconcile(listOf(accepted, uncertain("req-4")), receipts = null, transcript = emptySet())
        assertEquals(listOf(accepted, uncertain("req-4")), kept)
        // A real empty list still drops an accepted row the server no longer knows.
        assertNull(Outbox.reconcile(listOf(accepted), emptyList(), emptySet()).firstOrNull())
    }

    @Test
    fun own_message_with_lost_response_renders_as_you_through_the_receipt_link_not_text() {
        val ledger = SentLedger(fake)
        val after = Outbox.reconcile(listOf(uncertain("req-5")), listOf(receipt("req-5", "msg-5")), emptySet())
        after.filter { it.author == null && it.messageID != null }.forEach { ledger.record(it.sessionID, it.messageID!!) }
        val mine = ledger.mine("ses_a")
        assertEquals(Author.You, Authorship.of(user("msg-5"), mine))
        // Same text, different id, no receipt link: never You.
        assertTrue(Authorship.of(user("msg-9"), mine) is Author.Unattributed)
        assertTrue(Authorship.of(user("msg-9"), emptySet()) is Author.Unattributed)
    }

    @Test
    fun follow_scroll_rules() {
        assertTrue(Follow.shouldFollow(userScrolledUp = false, justSent = false))
        assertTrue(Follow.shouldFollow(userScrolledUp = true, justSent = true))
        assertTrue(!Follow.shouldFollow(userScrolledUp = true, justSent = false))
        assertTrue(!Follow.scrolledUp(firstVisibleIndex = 0, firstVisibleOffset = 40))
        assertTrue(Follow.scrolledUp(firstVisibleIndex = 2, firstVisibleOffset = 0))
        assertTrue(Follow.scrolledUp(firstVisibleIndex = 0, firstVisibleOffset = 900))
    }
}
