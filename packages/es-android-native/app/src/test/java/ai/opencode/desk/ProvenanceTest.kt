package ai.opencode.desk

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvenanceTest {
    @Test
    fun no_source_is_the_human() {
        assertEquals(Provenance.Human, Provenance.of(null))
        assertNull(Provenance.Human.headline())
        assertNull(Provenance.Human.detail())
    }

    @Test
    fun editspace_mail_maps_every_schema_field() {
        val mail = Provenance.of(buildJsonObject {
            put("type", "editspace-mail"); put("id", "android-native#13"); put("sender", "es-android"); put("recipient", "android-native")
            put("kind", "task"); put("in_reply_to", "android-native#11"); put("senderSession", "ses_lead"); put("relationship", "lead")
            put("originRun", "ses_lead"); put("supersedes", "android-native#12")
        }) as Provenance.Mail
        assertEquals("android-native#13", mail.id)
        assertEquals("es-android", mail.sender)
        assertEquals("android-native", mail.recipient)
        assertEquals("task", mail.kind)
        assertEquals("android-native#11", mail.inReplyTo)
        assertEquals("ses_lead", mail.senderSession)
        assertEquals("lead", mail.relationship)
        assertEquals("android-native#12", mail.supersedes)
        assertEquals("mail · es-android → android-native · task", mail.headline())
        assertEquals("id android-native#13 · reply to android-native#11 · supersedes android-native#12 · relationship lead · sender session ses_lead · origin run ses_lead", mail.detail())
    }

    @Test
    fun mail_with_only_required_fields_still_reads() {
        val mail = Provenance.of(buildJsonObject { put("type", "editspace-mail"); put("id", "x#1"); put("sender", "a"); put("recipient", "b") })
        assertEquals("mail · a → b", mail.headline())
        assertEquals("id x#1", mail.detail())
    }

    @Test
    fun a_future_source_type_is_kept_with_its_fields_not_dropped() {
        val other = Provenance.of(buildJsonObject { put("type", "heartbeat"); put("kind", "idle"); put("interval", 300); put("from", "scheduler") })
        assertTrue(other is Provenance.Other)
        assertEquals("heartbeat", other.type)
        assertEquals("heartbeat · scheduler · idle", other.headline())
        assertEquals(mapOf("kind" to "idle", "interval" to "300", "from" to "scheduler"), (other as Provenance.Other).fields)
    }

    @Test
    fun a_source_without_a_type_is_unknown_not_human() {
        val odd = Provenance.of(buildJsonObject { put("sender", "x") })
        assertEquals("unknown", odd.type)
        assertTrue(odd != Provenance.Human)
    }
}

class SourceUnionTest {
    @Test
    fun integration_system_and_operator_parse_with_their_fields() {
        val integration = Provenance.of(buildJsonObject { put("type", "integration"); put("name", "rook"); put("request", "AND-1"); put("claimedAuthor", "M") })
        assertEquals(Provenance.Integration("rook", "AND-1", "M"), integration)
        assertEquals("integration · rook · claims: M", integration.headline())
        val system = Provenance.of(buildJsonObject { put("type", "system"); put("kind", "nudge"); put("actor", "es-app") })
        assertEquals(Provenance.System("nudge", "es-app"), system)
        assertEquals("system · nudge · es-app", system.headline())
        assertEquals("actor es-app", system.detail())
        val operator = Provenance.of(buildJsonObject { put("type", "operator"); put("channel", "attention") })
        assertEquals(Provenance.Operator("attention"), operator)
        assertEquals("Murtaza · via attention", operator.headline())
    }

    @Test
    fun missing_optional_fields_degrade_gracefully() {
        assertEquals(Provenance.System("system", null), Provenance.of(buildJsonObject { put("type", "system") }))
        assertEquals(Provenance.Operator(null), Provenance.of(buildJsonObject { put("type", "operator") }))
        assertNull(Provenance.Operator(null).detail())
    }
}
