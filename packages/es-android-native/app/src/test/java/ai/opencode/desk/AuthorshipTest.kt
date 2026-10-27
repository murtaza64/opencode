package ai.opencode.desk

import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.MessageInfo
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.Part
import ai.opencode.desk.model.SessionTime
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Fixtures in the shapes the server emits (user info.source = SessionMailSource; parts text/tool).
class AuthorshipTest {
    private fun user(id: String, text: String, source: JsonObject? = null, partMeta: JsonObject? = null) =
        MessageWithParts(MessageInfo(id = id, role = "user", source = source, time = SessionTime(created = 1)), listOf(Part(id = "p$id", type = "text", text = text, metadata = partMeta)))
    private fun assistant(id: String) = MessageWithParts(MessageInfo(id = id, role = "assistant"), listOf(Part(id = "p$id", type = "text", text = "ok")))
    private fun mail(sender: String, kind: String? = null, relationship: String? = null) = buildJsonObject {
        put("type", "editspace-mail"); put("id", "$sender#1"); put("sender", sender); put("recipient", "android-native")
        if (kind != null) put("kind", kind); if (relationship != null) put("relationship", relationship)
    }

    @Test
    fun typed_mail_task_is_the_agent_with_kind() {
        val author = Authorship.of(user("m1", "Please build 0.1.6", mail("es-android", "task")), emptySet())
        assertEquals(Author.Agent("es-android", "task", null), author)
        assertEquals("es-android · task", author!!.label)
        assertEquals("Mail from es-android, task", author.description)
    }

    @Test
    fun agent_answer_mail_is_the_agent_with_kind_answer() {
        assertEquals(Author.Agent("front-desk", "answer", null), Authorship.of(user("m2", "Use option B", mail("front-desk", "answer")), emptySet()))
    }

    @Test
    fun forwarded_mail_shows_the_relationship_not_the_original_author() {
        val author = Authorship.of(user("m3", "Murtaza says: go with A", mail("orchestrator", "notice", "forwarded by orchestrator")), emptySet())
        assertEquals("orchestrator · notice · forwarded by orchestrator", author!!.label)
        assertFalse(author == Author.You)
    }

    @Test
    fun a_message_this_phone_sent_is_you_only_by_ledger_match() {
        val message = user("m4", "What changed since this morning?")
        assertEquals(Author.You, Authorship.of(message, setOf("m4")))
        assertEquals(Author.Unattributed(null), Authorship.of(message, emptySet()))
        assertEquals("Sent from this phone", Author.You.description)
    }

    @Test
    fun recovery_and_other_typed_system_kinds_are_system() {
        assertEquals(Author.System("recovery"), Authorship.of(user("m5", "Resuming after restart", buildJsonObject { put("type", "recovery") }), emptySet()))
        assertEquals(Author.System("heartbeat"), Authorship.of(user("m6", "tick", buildJsonObject { put("type", "heartbeat") }), emptySet()))
        assertEquals("system · recovery", Author.System("recovery").label)
    }

    @Test
    fun synthetic_context_parts_are_system_even_without_a_source() {
        val meta = buildJsonObject { put("source", "es-app/front-desk") }
        assertEquals(Author.System("synthetic"), Authorship.of(user("m7", "<context>…</context>", partMeta = meta), emptySet()))
    }

    @Test
    fun legacy_untyped_message_is_unattributed_never_you() {
        val author = Authorship.of(user("m8", "approve the merge"), emptySet())
        assertEquals(Author.Unattributed(null), author)
        assertEquals("unattributed", author!!.label)
        assertEquals("Input with no recorded source", author.description)
    }

    @Test
    fun unknown_future_source_type_is_unattributed_with_its_type() {
        val author = Authorship.of(user("m9", "hi", buildJsonObject { put("type", "telepathy"); put("sender", "slack") }), emptySet())
        assertEquals(Author.Unattributed("telepathy"), author)
        assertEquals("unattributed · telepathy", author!!.label)
    }

    @Test
    fun a_quoted_approval_inside_agent_mail_stays_the_agents_message() {
        val author = Authorship.of(user("m10", "Human approved: \"yes, ship it\" — proceeding", mail("gaming-pc-setup", "notice")), emptySet())
        assertEquals(Author.Agent("gaming-pc-setup", "notice", null), author)
        assertFalse(author == Author.You)
    }

    @Test
    fun assistant_messages_have_no_author() {
        assertNull(Authorship.of(assistant("a1"), setOf("a1")))
    }

    @Test
    fun receipts_follow_the_same_rules_using_request_ids() {
        val mine = InputReceipt(requestID = "req-1", sessionID = "s", text = "x")
        val peer = InputReceipt(requestID = "req-2", sessionID = "s", text = "y", source = mail("es-android", "task"))
        val legacy = InputReceipt(requestID = "req-3", sessionID = "s", text = "z")
        assertEquals(Author.You, Authorship.ofReceipt(mine, setOf("req-1")))
        assertEquals(Author.Agent("es-android", "task", null), Authorship.ofReceipt(peer, setOf("req-1")))
        assertEquals(Author.Unattributed(null), Authorship.ofReceipt(legacy, setOf("req-1")))
    }

    @Test
    fun coalescing_happens_only_within_one_author() {
        val placed = Authorship.place(listOf(
            user("u1", "a", mail("es-android", "task")),
            user("u2", "b", mail("es-android", "task")),
            user("u3", "c", mail("front-desk", "task")),
            assistant("a1"),
            user("u4", "d"),
            user("u5", "e"),
            user("u6", "f"),
        ), setOf("u5"))
        assertEquals(listOf(true, false, true, true, true, true, true), placed.map { it.first })
        assertEquals(Author.You, placed[5].author)
        assertEquals(Author.Unattributed(null), placed[6].author)
    }

    @Test
    fun an_assistant_turn_breaks_a_run() {
        val placed = Authorship.place(listOf(user("u1", "a", mail("x")), assistant("a1"), user("u2", "b", mail("x"))), emptySet())
        assertEquals(listOf(true, true, true), placed.map { it.first })
    }
}
