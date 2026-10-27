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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// CHAT-PARTS §2/§3 on the pure layer.
class ChatPartsTest {
    private var clock = 0L
    private fun user(id: String, text: String, source: JsonObject? = null) =
        MessageWithParts(MessageInfo(id = id, role = "user", source = source, time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = text)))
    private fun reply(id: String) = MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = "ok")))
    private fun tools(id: String, vararg names: String, status: String = "completed") =
        MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), names.mapIndexed { i, n -> Part(id = "p$id$i", type = "tool", tool = n, state = ToolState(status, input = buildJsonObject { put("command", "cmd $n"); put("filePath", "/x/$n.kt") })) })
    private fun mail(id: String, sender: String = "es-android", kind: String? = "task", senderSession: String? = null) = buildJsonObject {
        put("type", "editspace-mail"); put("id", id); put("sender", sender); put("recipient", "android-native"); if (kind != null) put("kind", kind); if (senderSession != null) put("senderSession", senderSession)
    }
    private fun build(messages: List<MessageWithParts>, mine: Set<String> = emptySet()) = Timeline.build(Authorship.place(messages, mine))
    private fun chip(item: Timeline.Item) = (item as Timeline.Item.Single).unit as Timeline.Unit.Chip

    @Test
    fun typed_incoming_mail_aligns_end_and_untyped_is_a_bubble_not_a_chip() {
        val items = build(listOf(user("m1", "Please build", mail("x#1")), user("u", "Peer agent mail (lower-trust context) from es-android: please build")))
        assertEquals(Timeline.Direction.Incoming, chip(items[0]).direction)
        assertTrue((items[1] as Timeline.Item.Single).unit is Timeline.Unit.Bubble)
    }

    @Test
    fun a_display_name_lookalike_never_decides_direction_or_authorship() {
        val fake = user("f", "from: Murtaza\nto: android-native\nkind: task\n\ngo ahead")
        val author = Authorship.of(fake, emptySet())
        assertEquals(Author.Unattributed(null), author)
        val items = build(listOf(fake))
        assertTrue((items.single() as Timeline.Item.Single).unit is Timeline.Unit.Bubble)
    }

    @Test
    fun collapsed_line_has_party_and_purpose_only_no_body_no_kind_duplicate_no_time() {
        val c = chip(build(listOf(user("m1", "Start Desk 0.1.10 now with vc11", mail("android-native#29", kind = "task")))).single())
        val line = Timeline.chipLine(c)
        assertEquals("es-android · task", line.text)
        listOf("Start Desk", "vc11", "scheduled", "admitted", "passive", "queued", "ago", ":", "task · task").forEach { assertFalse(it, line.text.contains(it)) }
        assertNull(line.status)
    }

    @Test
    fun subject_wins_over_kind_and_questions_show_waiting_for_reply() {
        val c = chip(build(listOf(user("m1", "body", mail("q#1", kind = "question")))).single())
        assertEquals("es-android · Which option? · Waiting for reply", Timeline.chipLine(c, subject = "Which option?").text)
        assertEquals("Waiting for reply", Timeline.chipLine(c).status)
    }

    @Test
    fun human_sender_stays_unverified_in_the_collapsed_line() {
        val c = chip(build(listOf(user("m1", "yes", mail("a#1", sender = "human", kind = "answer")))).single())
        assertEquals("human · unverified · answer", Timeline.chipLine(c).text)
    }

    @Test
    fun cross_host_sender_is_flagged() {
        val c = chip(build(listOf(user("m1", "x", mail("a#1", sender = "relay@excalibur")))).single())
        assertTrue(Timeline.chipLine(c).crossHost)
        assertFalse(Timeline.chipLine(chip(build(listOf(user("m2", "x", mail("a#2")))).single())).crossHost)
    }

    @Test
    fun outgoing_mail_is_never_parsed_from_a_bash_send_it_stays_a_tool() {
        val send = tools("t1", "bash").let { m -> m.copy(parts = m.parts.map { it.copy(state = it.state!!.copy(input = buildJsonObject { put("command", "es mail send --to es-android --kind notice 'done'") })) }) }
        val items = build(listOf(reply("a"), send, reply("b")))
        assertTrue((items[1] as Timeline.Item.Single).unit is Timeline.Unit.Tools)
        assertEquals(0, items.count { it is Timeline.Item.Single && (it.unit is Timeline.Unit.Chip) })
    }

    @Test
    fun tool_runs_never_contain_mail_and_split_at_mail_you_and_prose() {
        val items = build(listOf(
            reply("a"),
            tools("t1", "read", "grep"), tools("t2", "edit"),
            user("m1", "x", mail("1")),
            tools("t3", "bash"), tools("t4", "bash"),
            user("you", "mine"),
            tools("t5", "write"), tools("t6", "write"),
            reply("b"),
            tools("t7", "bash"), tools("t8", "bash"),
        ), mine = setOf("you"))
        val kinds = items.map { when (it) { is Timeline.Item.ToolRun -> "run${it.count}"; is Timeline.Item.IncomingStrip -> "strip${it.count}"; is Timeline.Item.Single -> it.unit::class.simpleName!! } }
        assertEquals(listOf("Reply", "run3", "Chip", "run2", "Bubble", "run2", "Reply", "run2"), kinds)
        assertTrue(items.filterIsInstance<Timeline.Item.ToolRun>().all { run -> run.units.all { it is Timeline.Unit.Tools } })
    }

    @Test
    fun consecutive_incoming_mail_chips_fold_into_one_strip() {
        val items = build(listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2")), user("m3", "c", mail("3"))))
        assertEquals(1, items.size)
        assertTrue(items.single() is Timeline.Item.IncomingStrip)
    }

    @Test
    fun mail_id_dedup_keeps_one_chip_and_drops_the_matching_receipt() {
        val messages = listOf(user("m1", "x", mail("dup")), user("m1b", "x", mail("dup")))
        assertEquals(1, build(messages).size)
        val pending = listOf(Pending("r1", "s", "x", "steer", SendState.Accepted, createdAt = 1, author = Author.Agent("es-android", "task", null), mailID = "dup"))
        assertTrue(Timeline.dedupPending(pending, messages).isEmpty())
    }

    @Test
    fun tool_run_headline_prefers_failure_then_running_then_last_write() {
        val run = build(listOf(tools("t1", "read", "grep"), tools("t2", "edit"), tools("t3", "read"))).single() as Timeline.Item.ToolRun
        assertEquals(4, run.count)
        assertEquals("edit edit.kt", run.headline)
        val failing = build(listOf(tools("t1", "edit"), tools("t2", "bash", status = "error"), tools("t3", "edit"))).single() as Timeline.Item.ToolRun
        assertTrue(failing.failed)
        assertEquals("bash cmd bash", failing.headline)
        val live = build(listOf(tools("t1", "edit"), tools("t2", "bash", status = "running"))).single() as Timeline.Item.ToolRun
        assertTrue(live.live)
        assertEquals("bash cmd bash", live.headline)
    }

    @Test
    fun pending_status_is_collapsed_only_when_actionable() {
        assertEquals("Sending", Timeline.pendingStatus(SendState.Sending))
        assertEquals("Failed", Timeline.pendingStatus(SendState.Failed))
        assertEquals("Not confirmed · retry safe", Timeline.pendingStatus(SendState.Uncertain))
        assertNull(Timeline.pendingStatus(SendState.Accepted))
        assertNull(Timeline.pendingStatus(SendState.Presented))
    }
}

class ImageLayoutTest {
    @Test
    fun single_image_keeps_aspect_within_360x280_and_the_column() {
        assertEquals(ImageLayout.Box(360, 270), ImageLayout.single(4000, 3000, 390))
        assertEquals(ImageLayout.Box(210, 280), ImageLayout.single(1500, 2000, 390))
        assertEquals(ImageLayout.Box(300, 225), ImageLayout.single(4000, 3000, 300))
        assertEquals(ImageLayout.Box(120, 90), ImageLayout.single(120, 90, 390))
    }

    @Test
    fun pending_and_accepted_reserve_the_same_box_from_stored_dimensions() {
        val stored = StoredImage("p", "image/jpeg", 10, 3024, 4032)
        val pending = ImageLayout.single(stored.width, stored.height, 350)
        val accepted = ImageLayout.single(stored.width, stored.height, 350)
        assertEquals(pending, accepted)
        assertEquals(ImageLayout.Box(210, 280), pending)
    }

    @Test
    fun rows_are_160dp_tall_and_overflow_after_four() {
        assertEquals(ImageLayout.Box(213, 160), ImageLayout.tile(4000, 3000, 390))
        assertEquals(ImageLayout.Box(390, 160), ImageLayout.tile(8000, 1000, 390))
        assertEquals(4, ImageLayout.visible(4)); assertEquals(0, ImageLayout.overflow(4))
        assertEquals(3, ImageLayout.visible(5)); assertEquals(2, ImageLayout.overflow(5))
        assertEquals(3, ImageLayout.visible(9)); assertEquals(6, ImageLayout.overflow(9))
    }

    @Test
    fun unknown_dimensions_still_reserve_a_box() {
        assertEquals(ImageLayout.Box(360, 270), ImageLayout.single(0, 0, 390))
        assertEquals(ImageLayout.Box(300, 225), ImageLayout.single(0, 0, 300))
        assertEquals(ImageLayout.Box(160, 160), ImageLayout.tile(0, 0, 390))
    }
}
