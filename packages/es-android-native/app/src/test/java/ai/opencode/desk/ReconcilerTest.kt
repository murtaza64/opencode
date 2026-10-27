package ai.opencode.desk

import ai.opencode.desk.net.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Runs the shared inbox-push fixture (proto/fixture.json, 14 cases) against the Kotlin port so
// Desk and Editspace.app alert on exactly the same transitions.
class ReconcilerTest {
    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.intOrNull
    private fun JsonObject.long(k: String) = (this[k] as? JsonPrimitive)?.longOrNull

    private fun record(o: JsonObject) = Reconciler.Record(
        editspace = o.str("editspace")!!, id = o.str("id")!!, revision = o.int("revision") ?: 0, title = o.str("title").orEmpty(),
        status = o.str("status")!!, contentRevision = o.int("content_revision"), deliveryState = o.str("delivery_state"),
        answeredAt = (o["answer"] as? JsonObject)?.long("answered_at"),
    )
    private fun request(o: JsonObject) = Reconciler.Request(o.str("kind")!!, o.str("editspace")!!, o.str("id")!!, o.str("session"), o.str("title").orEmpty())

    @Test
    fun shared_fixture_cases_all_match_the_reference_reconciler() {
        val cases = json.parseToJsonElement(javaClass.getResource("/reconcile-fixture.json")!!.readText()).jsonArray
        assertEquals(14, cases.size)
        cases.forEach { c ->
            val case = c.jsonObject
            val name = case.str("name")
            val ledger = (case["ledger"] as JsonObject).mapValues { it.value.jsonPrimitive.content.toInt() }
            val result = Reconciler.reconcile(
                case.str("origin")!!,
                (case["attention"] as JsonArray).map { record(it.jsonObject) },
                (case["requests"] as JsonArray).map { request(it.jsonObject) },
                ledger,
                case.long("now") ?: 0,
            )
            val got = result.actions.map { when (it) { is Reconciler.Action.Post -> "post"; is Reconciler.Action.Update -> "update"; is Reconciler.Action.Cancel -> "cancel" } to it.tag }
            val want = (case["want"] as JsonArray).map { pair -> pair.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } }
            assertEquals("case '$name' actions", want, got)
            (case["want_ledger"] as? JsonObject)?.let { wantLedger ->
                assertEquals("case '$name' ledger", wantLedger.mapValues { it.value.jsonPrimitive.content.toInt() }, result.ledger)
            }
        }
    }

    @Test
    fun tags_parse_back_into_deep_link_targets() {
        assertEquals(Reconciler.Target("https://mini:8443", "opencode", "attention", "att_1"), Reconciler.target("https://mini:8443|opencode|att:att_1"))
        assertEquals(Reconciler.Target("https://mini:8443", "opencode", "attention", "att_1"), Reconciler.target("https://mini:8443|opencode|att:att_1:stalled"))
        assertEquals(Reconciler.Target("http://127.0.0.1:47120", "dotfiles", "request", "per_9"), Reconciler.target("http://127.0.0.1:47120|dotfiles|req:per_9"))
        assertNull(Reconciler.target("garbage"))
        assertNull(Reconciler.target("a|b|zzz:1"))
    }
}
