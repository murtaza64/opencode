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
import org.junit.Assert.assertTrue
import org.junit.Test

// 0.1.11: same-side/source-class coalescing, incoming strips, and grouping frozen while live.
class GroupingTest {
    private var clock = 0L
    private fun user(id: String, text: String, source: JsonObject? = null) =
        MessageWithParts(MessageInfo(id = id, role = "user", source = source, time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = text)))
    private fun reply(id: String) = MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), listOf(Part(id = "p$id", type = "text", text = "ok")))
    private fun tools(id: String, vararg names: String) =
        MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = ++clock)), names.mapIndexed { i, n -> Part(id = "p$id$i", type = "tool", tool = n, state = ToolState("completed", input = buildJsonObject { put("command", "cmd") })) })
    private fun mail(id: String, sender: String = "es-android", kind: String? = "task", senderSession: String? = null) = buildJsonObject {
        put("type", "editspace-mail"); put("id", id); put("sender", sender); put("recipient", "android-native"); if (kind != null) put("kind", kind); if (senderSession != null) put("senderSession", senderSession)
    }
    private fun build(messages: List<MessageWithParts>, mine: Set<String> = emptySet()) = Timeline.build(Authorship.place(messages, mine))
    private fun shape(items: List<Timeline.Item>) = items.map { when (it) { is Timeline.Item.ToolRun -> "run${it.count}"; is Timeline.Item.IncomingStrip -> "strip${it.count}"; is Timeline.Item.Single -> it.unit::class.simpleName!! } }

    @Test
    fun consecutive_incoming_mail_folds_into_a_strip_with_latest_party_and_status() {
        val items = build(listOf(user("m1", "a", mail("1", "es-app")), user("m2", "b", mail("2", "front-desk", "question")), user("m3", "c", mail("3", "relay"))))
        val strip = items.single() as Timeline.Item.IncomingStrip
        assertEquals(3, strip.count)
        assertEquals("3 mail · relay · Waiting for reply", strip.label)
        assertEquals(listOf("m1", "m2", "m3"), strip.chips.map { it.message.info.id })
    }

    @Test
    fun an_incoming_strip_never_takes_tools_and_a_tool_run_never_takes_mail() {
        val items = build(listOf(user("m1", "a", mail("1")), tools("t1", "bash"), tools("t2", "bash"), user("m2", "b", mail("2")), user("m3", "c", mail("3"))))
        assertEquals(listOf("Chip", "run2", "strip2"), shape(items))
        assertTrue(items.filterIsInstance<Timeline.Item.ToolRun>().all { r -> r.units.all { it is Timeline.Unit.Tools } })
        assertTrue(items.filterIsInstance<Timeline.Item.IncomingStrip>().all { s -> s.chips.all { it is Timeline.Unit.Chip } })
    }

    @Test
    fun strips_break_at_you_operator_prose_unattributed_system_and_host_change() {
        val op = buildJsonObject { put("type", "operator"); put("channel", "attention") }
        val sys = buildJsonObject { put("type", "system"); put("kind", "recovery") }
        val items = build(listOf(
            user("m1", "a", mail("1")), user("m2", "b", mail("2")),
            user("you", "mine"),
            user("m3", "c", mail("3")), user("m4", "d", mail("4")),
            user("o", "ok", op),
            user("m5", "e", mail("5")), user("m6", "f", mail("6")),
            reply("r"),
            user("m7", "g", mail("7")), user("m8", "h", mail("8")),
            user("u", "untyped"),
            user("m9", "i", mail("9")), user("m10", "j", mail("10")),
            user("s", "recover", sys),
            user("m11", "k", mail("11", senderSession = "ses_x@laptop")), user("m12", "l", mail("12", senderSession = "ses_y@excalibur")),
        ), mine = setOf("you"))
        assertEquals(listOf("strip2", "Bubble", "strip2", "Bubble", "strip2", "Reply", "strip2", "Bubble", "strip2", "Bubble", "Chip", "Chip"), shape(items))
    }

    @Test
    fun strip_counts_distinct_mail_ids() {
        val strip = build(listOf(user("m1", "a", mail("dup")), user("m1b", "a", mail("dup")), user("m2", "b", mail("2")))).single() as Timeline.Item.IncomingStrip
        assertEquals(2, strip.count)
        assertEquals(listOf("m1", "m2"), strip.chips.map { it.message.info.id })
    }

    @Test
    fun group_keys_are_stable_ids_not_positions() {
        val a = build(listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2"))))
        val b = build(listOf(reply("new-first"), user("m1", "a", mail("1")), user("m2", "b", mail("2"))))
        assertEquals("strip-m1", Timeline.key(a[0]))
        assertEquals("strip-m1", Timeline.key(b[1]))
        assertEquals("run-t1", Timeline.key(build(listOf(tools("t1", "bash"), tools("t2", "bash"))).single()))
    }

    @Test
    fun while_running_new_items_append_as_their_own_chips_and_prior_groups_keep_their_keys() {
        val base = listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2")), tools("t1", "bash"), tools("t2", "bash"))
        val before = Timeline.build(Authorship.place(base, emptySet()))
        assertEquals(listOf("strip2", "run2"), shape(before))
        val after = Timeline.buildFrozen(before, Authorship.place(base + user("m3", "c", mail("3")) + tools("t3", "edit") + tools("t4", "edit"), emptySet()), running = true)
        assertEquals(listOf("strip-m1", "run-t1"), after.take(2).map(Timeline::key))
        // New parts never reparent or collapse into a trailing group while active.
        assertEquals(listOf("strip2", "run2", "Chip", "Tools", "Tools"), shape(after))
        assertEquals(listOf("m3", "t3", "t4"), after.drop(2).map(Timeline::key))
    }

    @Test
    fun finalization_happens_only_on_a_real_busy_to_idle_or_error_transition() {
        assertTrue(Timeline.finalizes("busy", "idle"))
        assertTrue(Timeline.finalizes("busy", "error"))
        assertTrue(Timeline.finalizes("busy", "completed"))
        listOf("unknown", "retry", "reconnecting", "busy", null).forEach { assertTrue("busy->$it must not finalize", !Timeline.finalizes("busy", it)) }
        assertTrue(!Timeline.finalizes("idle", "idle"))
        assertTrue(!Timeline.finalizes("unknown", "idle"))
    }

    @Test
    fun a_group_inherits_expanded_state_from_any_member() {
        val strip = build(listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2")))).single()
        assertTrue(Timeline.inheritsExpanded(strip, setOf("m2")))
        assertTrue(!Timeline.inheritsExpanded(strip, setOf("m9")))
    }

    @Test
    fun regroup_applies_when_the_run_ends() {
        val base = listOf(user("m1", "a", mail("1")), tools("t1", "bash"))
        val before = Timeline.build(Authorship.place(base, emptySet()))
        val full = base + tools("t2", "bash") + user("m2", "b", mail("2")) + user("m3", "c", mail("3"))
        val frozen = Timeline.buildFrozen(before, Authorship.place(full, emptySet()), running = true)
        assertEquals(listOf("Chip", "Tools", "Tools", "Chip", "Chip"), shape(frozen))
        val ended = Timeline.buildFrozen(frozen, Authorship.place(full, emptySet()), running = false)
        assertEquals(listOf("Chip", "run2", "strip2"), shape(ended))
        assertEquals(shape(Timeline.build(Authorship.place(full, emptySet()))), shape(ended))
    }

    @Test
    fun frozen_build_drops_groups_whose_members_vanished_and_dedups_appended_mail_ids() {
        val base = listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2")))
        val before = Timeline.build(Authorship.place(base, emptySet()))
        val after = Timeline.buildFrozen(before, Authorship.place(listOf(user("m2", "b", mail("2")), user("m2b", "b", mail("2"))), emptySet()), running = true)
        assertEquals(listOf("Chip"), shape(after))
        assertEquals("m2", Timeline.key(after.single()))
    }

    @Test
    fun without_a_previous_build_or_when_idle_the_full_grouping_is_used() {
        val base = listOf(user("m1", "a", mail("1")), user("m2", "b", mail("2")))
        assertEquals(listOf("strip2"), shape(Timeline.buildFrozen(null, Authorship.place(base, emptySet()), running = true)))
        assertEquals(listOf("strip2"), shape(Timeline.buildFrozen(emptyList(), Authorship.place(base, emptySet()), running = false)))
    }
}
