package ai.opencode.desk

import ai.opencode.desk.model.StateResponse
import ai.opencode.desk.net.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// SPEC-0.1.19-FINDABILITY on the Mini rollover state: sort, chips, lineage and Home ranking.
class FinderTest {
    private val state = json.decodeFromString<StateResponse>(javaClass.getResource("/mini-state-rollover.json")!!.readText())
    private val agents = Agents.derive("opencode", state)
    private val relay = "opencode/orchestrator"
    private val e7fb = "ses_e7fbd738cffenSQHMiPq6iSx7Z"
    private val old = "ses_7efac8ae359f5cc8eed9a52ed73b2344"

    @Test
    fun relay_and_orchestrator_each_find_one_lane_row_that_opens_e7fb_with_7efac_only_as_history() {
        listOf("relay", "orchestrator").forEach { q ->
            val rows = Finder.apply(agents, q, Finder.Sort.Recent, emptySet(), Finder.Signals())
            assertEquals(q, listOf(relay), rows.map { it.key })
            assertEquals(e7fb, rows.single().session?.id)
            assertEquals(listOf(old), rows.single().history.map { it.id })
        }
    }

    @Test
    fun sort_by_my_last_message_puts_the_lane_i_messaged_first_and_name_sorts_alphabetically() {
        val signals = Finder.Signals(lastSent = mapOf(e7fb to 1_000L))
        assertEquals(relay, Finder.apply(agents, "", Finder.Sort.MyMessage, emptySet(), signals).first().key)
        val names = Finder.apply(agents, "", Finder.Sort.Name, emptySet(), Finder.Signals()).map { it.title.lowercase() }
        assertEquals(names.sorted(), names)
        val statuses = Finder.apply(agents, "", Finder.Sort.Status, emptySet(), Finder.Signals()).map { it.status }
        assertEquals("busy", statuses.first())
    }

    @Test
    fun chips_are_offered_only_when_a_row_matches_and_combine_as_and() {
        val none = Finder.availableChips(agents, Finder.Signals())
        assertTrue(Finder.Chip.Working in none)
        assertFalse(Finder.Chip.Pinned in none)
        assertFalse(Finder.Chip.Messaged in none)
        val signals = Finder.Signals(pinned = setOf(relay), needsYou = setOf(relay), lastSent = mapOf(old to 5L))
        assertEquals(Finder.Chip.entries.toList(), Finder.availableChips(agents, signals))
        val both = Finder.apply(agents, "", Finder.Sort.Recent, setOf(Finder.Chip.Pinned, Finder.Chip.Working), signals)
        assertEquals(listOf(relay), both.map { it.key })
        assertTrue(Finder.apply(agents, "", Finder.Sort.Recent, setOf(Finder.Chip.Pinned), Finder.Signals()).isEmpty())
    }

    @Test
    fun home_conversations_rank_by_my_last_message_and_fall_back_to_pinned_and_opened() {
        val other = agents.first { it.key != relay && it.sessions.isNotEmpty() }
        val ranked = Finder.conversations(agents, Finder.Signals(lastSent = mapOf(e7fb to 10L, other.session!!.id to 20L)))
        assertFalse(ranked.fallback)
        assertEquals(listOf(other.key, relay), ranked.agents.map { it.key })
        val fallback = Finder.conversations(agents, Finder.Signals(pinned = setOf(relay), opened = mapOf(other.key to 99L)))
        assertTrue(fallback.fallback)
        assertEquals(listOf(other.key, relay), fallback.agents.map { it.key })
        assertTrue(Finder.conversations(agents, Finder.Signals()).agents.isEmpty())
    }
}
