package ai.opencode.desk

import ai.opencode.desk.model.AttentionOption
import ai.opencode.desk.model.OptionChoice
import ai.opencode.desk.model.OptionInput
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionInputTest {
    private val reviewers = listOf(OptionChoice("alice", "Alice"), OptionChoice("bob", "Bob"), OptionChoice("cy", "Cy"))
    private val plain = AttentionOption("go", "Go ahead")
    private val text = AttentionOption("assign", "Assign reviewers", OptionInput("text", "Reviewers", required = true, hint = "One per pair"))
    private val optionalText = AttentionOption("note", "Add note", OptionInput("text", "Note", required = false))
    private val choice = AttentionOption("pick", "Pick a reviewer", OptionInput("choice", "Reviewer", required = true, choices = reviewers))
    private val multi = AttentionOption("pool", "Pick a pool", OptionInput("multi", "Reviewers", required = true, choices = reviewers, max = 2))
    private val unknown = AttentionOption("future", "Future", OptionInput("date", "When"))

    @Test
    fun option_without_input_is_sendable_with_no_value() {
        assertNull(AttentionInput.blocker(plain, AttentionInput.Draft()))
        assertNull(AttentionInput.value(plain, AttentionInput.Draft(text = "ignored")))
        assertTrue(AttentionInput.sendable(plain))
        assertTrue(AttentionInput.sendable(null))
    }

    @Test
    fun required_text_blocks_until_supplied() {
        assertEquals("Reviewers is required", AttentionInput.blocker(text, AttentionInput.Draft()))
        assertEquals("Reviewers is required", AttentionInput.blocker(text, AttentionInput.Draft(text = "   ")))
        assertNull(AttentionInput.blocker(text, AttentionInput.Draft(text = "alice, bob")))
        assertEquals(JsonPrimitive("alice, bob"), AttentionInput.value(text, AttentionInput.Draft(text = "alice, bob")))
    }

    @Test
    fun optional_text_may_be_empty_and_then_sends_no_value() {
        assertNull(AttentionInput.blocker(optionalText, AttentionInput.Draft()))
        assertNull(AttentionInput.value(optionalText, AttentionInput.Draft()))
    }

    @Test
    fun text_over_2000_chars_is_blocked() {
        assertEquals("Reviewers must be 2000 characters or fewer", AttentionInput.blocker(text, AttentionInput.Draft(text = "x".repeat(2001))))
    }

    @Test
    fun choice_needs_exactly_one_offered_id() {
        assertEquals("Pick one reviewer", AttentionInput.blocker(choice, AttentionInput.Draft()))
        assertEquals("Pick one offered reviewer", AttentionInput.blocker(choice, AttentionInput.Draft(picks = listOf("zed"))))
        assertNull(AttentionInput.blocker(choice, AttentionInput.Draft(picks = listOf("bob"))))
        assertEquals(JsonPrimitive("bob"), AttentionInput.value(choice, AttentionInput.Draft(picks = listOf("bob"))))
    }

    @Test
    fun multi_respects_max_distinct_and_offered_in_pick_order() {
        assertEquals("Pick at least one reviewers", AttentionInput.blocker(multi, AttentionInput.Draft()))
        assertEquals("Pick at most 2", AttentionInput.blocker(multi, AttentionInput.Draft(picks = listOf("alice", "bob", "cy"))))
        assertEquals("Duplicate pick", AttentionInput.blocker(multi, AttentionInput.Draft(picks = listOf("bob", "bob"))))
        assertEquals("Pick only offered reviewers", AttentionInput.blocker(multi, AttentionInput.Draft(picks = listOf("bob", "zed"))))
        assertNull(AttentionInput.blocker(multi, AttentionInput.Draft(picks = listOf("cy", "alice"))))
        assertEquals(JsonArray(listOf(JsonPrimitive("cy"), JsonPrimitive("alice"))), AttentionInput.value(multi, AttentionInput.Draft(picks = listOf("cy", "alice"))))
    }

    @Test
    fun unknown_kind_is_never_sendable() {
        assertFalse(AttentionInput.sendable(unknown))
        assertEquals("This option needs a newer app; answer in the source thread", AttentionInput.blocker(unknown, AttentionInput.Draft(text = "x")))
        assertNull(AttentionInput.value(unknown, AttentionInput.Draft(text = "x")))
    }

    @Test
    fun stored_values_render_with_choice_labels() {
        assertEquals("Bob", AttentionInput.render(choice.input, JsonPrimitive("bob")))
        assertEquals("Cy, Alice", AttentionInput.render(multi.input, JsonArray(listOf(JsonPrimitive("cy"), JsonPrimitive("alice")))))
        assertEquals("alice, bob", AttentionInput.render(text.input, JsonPrimitive("alice, bob")))
        assertNull(AttentionInput.render(text.input, null))
    }

    @Test
    fun ledger_error_string_is_shown_verbatim() {
        assertEquals("Reviewers is required for Assign reviewers", AttentionInput.ledgerError("""{"error":"Reviewers is required for Assign reviewers"}""", "HTTP 400"))
        assertEquals("plain text body", AttentionInput.ledgerError("plain text body", "HTTP 400"))
        assertEquals("HTTP 400", AttentionInput.ledgerError("", "HTTP 400"))
        assertEquals("HTTP 400", AttentionInput.ledgerError("""{"detail":"other"}""", "HTTP 400"))
    }
}
