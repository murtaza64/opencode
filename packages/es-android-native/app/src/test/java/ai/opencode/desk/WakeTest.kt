package ai.opencode.desk

import ai.opencode.desk.model.MessageInfo
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.Part
import ai.opencode.desk.model.SessionTime
import ai.opencode.desk.net.json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

class WakeTest {
    private fun delivery(mode: String = "actionable", outcomes: List<String> = emptyList(), presented: Long? = null, wake: String? = null) =
        Delivery(message_id = "m#1", recipient = "r", session = "ses_a", mode = mode, wake = wake, presented_ms = presented, wake_observations = outcomes.map { WakeObservation(it, 100) })

    @Test
    fun server_computed_wake_wins_when_present() {
        assertEquals(Wake.Caused, WakeRules.of(delivery(wake = "caused")).wake)
        assertEquals(Wake.Joined, WakeRules.of(delivery(wake = "joined")).wake)
        assertEquals(Wake.None, WakeRules.of(delivery(wake = "none", mode = "actionable")).wake)
        assertEquals(Wake.Unknown, WakeRules.of(delivery(wake = "unknown")).wake)
    }

    @Test
    fun raw_observations_follow_the_dashboard_rule() {
        assertEquals(Wake.Caused, WakeRules.of(delivery(outcomes = listOf("scheduled"), presented = 200)).wake)
        // scheduled but never presented is not proof it woke
        assertEquals(Wake.Unknown, WakeRules.of(delivery(outcomes = listOf("scheduled"))).wake)
        assertEquals(Wake.Joined, WakeRules.of(delivery(outcomes = listOf("coalesced"))).wake)
        assertEquals(Wake.None, WakeRules.of(delivery(mode = "passive", outcomes = listOf("scheduled"), presented = 1)).wake)
        assertEquals(Wake.Unknown, WakeRules.of(delivery()).wake)
    }

    @Test
    fun live_payload_shape_parses_and_admitted_alone_is_unknown() {
        val body = """{"editspace":"opencode","lane":"android-native","messages":[{"id":"android-native#39","ts":"2026-10-27T23:25:18Z","from":"android-lead","to":"android-native","kind":"task","deliveries":[{"message_id":"android-native#39","recipient":"android-native","session":"ses_e9bff3ca","mode":"actionable","state":"admitted","request_id":"msg_1","error":null,"presented_at":null,"handled_at":null,"wake_observations":[{"outcome":"scheduled","observedAt":1793143518434}]}]}]}"""
        val mail = json.decodeFromString<MailResponse>(body).messages
        val evidence = WakeRules.forMail(mail, "android-native#39", "ses_e9bff3ca")!!
        assertEquals(Wake.Unknown, evidence.wake)
        assertEquals(1793143518434L, evidence.observedAt)
        assertNull(evidence.presentedAt)
    }

    @Test
    fun iso_presented_time_turns_scheduled_into_caused() {
        val d = Delivery(mode = "actionable", presented_at = JsonPrimitive("2026-10-27T23:25:20+00:00"), wake_observations = listOf(WakeObservation("scheduled", 1)))
        val e = WakeRules.of(d)
        assertEquals(Wake.Caused, e.wake)
        assertEquals(1793143520000L, e.presentedAt)
    }

    @Test
    fun evidence_is_looked_up_by_mail_id_and_session_and_absent_when_unrecorded() {
        val mail = listOf(MailMessage(id = "x#1", deliveries = listOf(delivery(wake = "caused").copy(session = "ses_a"), delivery(wake = "none").copy(session = "ses_b"))))
        assertEquals(Wake.Caused, WakeRules.forMail(mail, "x#1", "ses_a")!!.wake)
        assertEquals(Wake.None, WakeRules.forMail(mail, "x#1", "ses_b")!!.wake)
        assertNull(WakeRules.forMail(mail, "x#2", "ses_a"))
        assertNull(WakeRules.forMail(listOf(MailMessage(id = "x#1")), "x#1", "ses_a"))
    }

    @Test
    fun accessible_text_and_marker_labels_match_the_contract() {
        assertEquals("Woke composer-float", WakeRules.description(Wake.Caused, "composer-float"))
        assertEquals("Arrived while composer-float was working", WakeRules.description(Wake.Joined, "composer-float"))
        assertEquals("Recorded, did not wake", WakeRules.description(Wake.None, "x"))
        assertEquals("Wake not confirmed", WakeRules.description(Wake.Unknown, "x"))
        assertEquals("Woke for passive review · 3 mail", WakeRules.markerLabel(WakeEvent("w1", cause = "passive-review", covers = listOf("a", "b", "c"))))
        assertEquals("Resumed", WakeRules.markerLabel(WakeEvent("w2", cause = "resume")))
        assertEquals("Recovered after restart", WakeRules.markerLabel(WakeEvent("w3", cause = "recovery")))
        assertEquals("Started from handoff", WakeRules.markerLabel(WakeEvent("w4", cause = "handoff-kickoff")))
    }

    @Test
    fun markers_are_inserted_by_time_and_never_join_groups() {
        var clock = 0L
        fun user(id: String): MessageWithParts { clock += 10; return MessageWithParts(MessageInfo(id = id, role = "user", time = SessionTime(created = clock)), listOf(Part(id = "p$id", type = "text", text = "x"))) }
        fun reply(id: String): MessageWithParts { clock += 10; return MessageWithParts(MessageInfo(id = id, role = "assistant", time = SessionTime(created = clock)), listOf(Part(id = "p$id", type = "text", text = "ok"))) }
        val items = Timeline.build(Authorship.place(listOf(user("u1"), reply("a1"), reply("a2")), emptySet()))
        val withMarkers = Timeline.withMarkers(items, listOf(WakeEvent("w-early", cause = "resume", at = 5), WakeEvent("w-mid", cause = "passive-review", at = 25)))
        assertEquals(listOf("wake-w-early", "u1", "a1", "wake-w-mid", "a2"), withMarkers.map(Timeline::key))
    }

    @Test
    fun timestamps_use_the_recorded_time_and_add_duration() {
        val utc = ZoneId.of("UTC")
        assertEquals("Tue 27 Oct, 14:02:11 (UTC+0)", Timestamps.format(1793109731000L, utc))
        assertEquals("Tue 27 Oct, 14:02:11 (UTC+0) · 42 s", Timestamps.details(1793109731000L, 1793109773000L, utc))
        assertEquals("Tue 27 Oct, 14:02:11 (UTC+0)", Timestamps.details(1793109731000L, null, utc))
        assertEquals("Tue 27 Oct, 10:02:11 (UTC-4)", Timestamps.format(1793109731000L, ZoneId.of("America/New_York")))
    }
}
