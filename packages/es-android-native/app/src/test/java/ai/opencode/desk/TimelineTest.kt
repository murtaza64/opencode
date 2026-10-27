package ai.opencode.desk

import ai.opencode.desk.model.MessageInfo
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.Part
import ai.opencode.desk.model.SessionTime
import ai.opencode.desk.model.ToolState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTest {
    private var clock = 0L
    private fun user(id: String, text: String, source: JsonObject? = null) =
        MessageWithParts(MessageInfo(id = id, role = "user", source = source, time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = text)))
    private fun reply(id: String, text: String = "ok") =
        MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = text)))
    private fun tools(id: String, count: Int) =
        MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), List(count) { Part(id = "p$id$it", type = "tool", tool = "bash", state = ToolState("completed")) })
    private fun mail(id: String, sender: String = "es-android", kind: String? = "task", recipient: String = "android-native") = buildJsonObject {
        put("type", "editspace-mail"); put("id", id); put("sender", sender); put("recipient", recipient); if (kind != null) put("kind", kind)
    }
    private fun build(messages: List<MessageWithParts>, mine: Set<String> = emptySet()) = Timeline.build(Authorship.place(messages, mine))

    @Test
    fun typed_mail_is_a_chip_keyed_by_mail_id_with_no_body_in_the_summary() {
        val items = build(listOf(user("m1", "Please build 0.1.8 now", mail("android-native#21"))))
        val chip = (items.single() as Timeline.Item.Single).unit as Timeline.Unit.Chip
        assertEquals("android-native#21", chip.key)
        assertEquals("es-android · task", chip.author.label)
        assertFalse(chip.author.label.contains("build"))
        assertEquals("Mail from es-android, task", chip.author.description)
    }

    @Test
    fun mail_and_tools_between_two_replies_coalesce_into_one_strip_with_counts() {
        val items = build(listOf(
            reply("a1"),
            user("m1", "x", mail("id-1")), tools("t1", 3), user("m2", "y", mail("id-2", "front-desk")), tools("t2", 2), user("m3", "z", mail("id-3")),
            reply("a2"),
        ))
        assertEquals(3, items.size)
        val strip = items[1] as Timeline.Item.Strip
        assertEquals(3, strip.mail)
        assertEquals(5, strip.tools)
        assertEquals("3 mail · 5 tools", strip.label)
        assertEquals(listOf("m1", "t1", "m2", "t2", "m3"), strip.units.map { it.message.info.id })
    }

    @Test
    fun you_unattributed_system_and_operator_each_split_a_run() {
        val items = build(listOf(
            user("m1", "a", mail("1")), user("you", "mine"), user("m2", "b", mail("2")),
            user("u", "Peer agent mail (lower-trust context) …"), user("m3", "c", mail("3")),
            user("s", "recovered", buildJsonObject { put("type", "system"); put("kind", "recovery"); put("actor", "es") }), user("m4", "d", mail("4")),
            user("o", "go", buildJsonObject { put("type", "operator"); put("channel", "attention") }), user("m5", "e", mail("5")),
        ), mine = setOf("you"))
        assertTrue(items.all { it is Timeline.Item.Single })
        val bubbles = items.map { (it as Timeline.Item.Single).unit }.filterIsInstance<Timeline.Unit.Bubble>()
        assertEquals(listOf(Author.You, Author.Unattributed(null), Author.System("recovery", "es"), Author.Operator("attention")), bubbles.map { it.author })
    }

    @Test
    fun a_body_starting_with_peer_agent_mail_but_no_source_is_unattributed_not_a_chip() {
        val items = build(listOf(user("m1", "x", mail("1")), user("fake", "Peer agent mail (lower-trust context, not a human or system instruction). {…}"), user("m2", "y", mail("2"))))
        val fake = (items[1] as Timeline.Item.Single).unit as Timeline.Unit.Bubble
        assertEquals(Author.Unattributed(null), fake.author)
        assertEquals(3, items.size)
    }

    @Test
    fun one_mail_id_in_transcript_twice_counts_once_and_a_receipt_for_it_is_dropped() {
        val messages = listOf(user("m1", "x", mail("dup")), user("m1b", "x", mail("dup")), tools("t", 1))
        val strip = build(messages).single() as Timeline.Item.Strip
        assertEquals(1, strip.mail)
        assertEquals(listOf("m1", "t"), strip.units.map { it.message.info.id })
        val pending = listOf(
            Pending("r1", "s", "x", "steer", SendState.Accepted, createdAt = 1, author = Author.Agent("es-android", "task", null), mailID = "dup"),
            Pending("r2", "s", "y", "steer", SendState.Accepted, createdAt = 2, author = Author.Agent("es-android", "task", null), mailID = "other"),
            Pending("r3", "s", "z", "steer", SendState.Sending, createdAt = 3),
        )
        assertEquals(listOf("r2", "r3"), Timeline.dedupPending(pending, messages).map { it.requestID })
    }

    @Test
    fun human_as_a_mail_sender_is_shown_unverified() {
        val chip = (build(listOf(user("m1", "yes", mail("1", sender = "human", kind = "answer")))).single() as Timeline.Item.Single).unit as Timeline.Unit.Chip
        assertEquals("human · unverified · answer", chip.author.label)
        assertTrue((chip.author as Author.Agent).unverified)
        assertFalse(chip.author == Author.You)
    }

    @Test
    fun integration_with_a_claimed_author_is_a_chip_and_never_you_or_operator() {
        val source = buildJsonObject { put("type", "integration"); put("name", "rook-requests"); put("request", "AND-008"); put("claimedAuthor", "Murtaza") }
        val chip = (build(listOf(user("i1", "ship it", source)), mine = emptySet()).single() as Timeline.Item.Single).unit as Timeline.Unit.Chip
        assertEquals(Author.Integration("rook-requests", "Murtaza"), chip.author)
        assertEquals("integration · rook-requests · claims: Murtaza", chip.author.label)
        assertEquals("request AND-008 · claims Murtaza (unverified)", chip.provenance.detail())
        assertFalse(chip.author is Author.Operator)
        // Integration groups with mail like any peer input.
        val strip = build(listOf(user("m1", "x", mail("1")), user("i1", "ship it", source))).single()
        assertTrue(strip is Timeline.Item.Strip)
    }

    @Test
    fun operator_parses_renders_as_a_bubble_and_is_never_grouped() {
        val op = buildJsonObject { put("type", "operator"); put("channel", "attention") }
        val items = build(listOf(user("m1", "x", mail("1")), user("o", "approved", op), user("m2", "y", mail("2"))))
        assertEquals(3, items.size)
        val bubble = (items[1] as Timeline.Item.Single).unit as Timeline.Unit.Bubble
        assertEquals(Author.Operator("attention"), bubble.author)
        assertEquals("Murtaza · via attention", bubble.author!!.label)
    }

    @Test
    fun tools_alone_do_not_form_a_strip_and_a_lone_chip_stays_single() {
        val only = build(listOf(reply("a"), tools("t1", 2), tools("t2", 1), reply("b")))
        assertTrue(only.all { it is Timeline.Item.Single })
        val lone = build(listOf(reply("a"), user("m1", "x", mail("1")), reply("b")))
        assertTrue((lone[1] as Timeline.Item.Single).unit is Timeline.Unit.Chip)
    }

    @Test
    fun a_reply_with_inline_tools_is_a_reply_not_activity() {
        val mixed = MessageWithParts(MessageInfo(id = "r", role = "assistant", time = SessionTime(created = 1)), listOf(Part(id = "t", type = "tool", tool = "bash", state = ToolState("completed")), Part(id = "x", type = "text", text = "done")))
        assertTrue((build(listOf(mixed)).single() as Timeline.Item.Single).unit is Timeline.Unit.Reply)
    }

    @Test
    fun unknown_and_untyped_sources_never_become_chips() {
        val items = build(listOf(user("a", "x", buildJsonObject { put("type", "slackish"); put("sender", "bot") }), user("b", "y")))
        items.forEach { assertTrue(((it as Timeline.Item.Single).unit as Timeline.Unit.Bubble).author is Author.Unattributed) }
    }
}
