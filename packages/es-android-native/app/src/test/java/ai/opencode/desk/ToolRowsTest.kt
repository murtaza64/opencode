package ai.opencode.desk

import ai.opencode.desk.model.Part
import ai.opencode.desk.model.ToolState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun tool(name: String, status: String = "completed", title: String? = null, input: JsonObject? = null, metadata: JsonObject? = null, output: String? = null, error: String? = null) =
    Part(id = "prt_$name", type = "tool", tool = name, state = ToolState(status = status, title = title, input = input, metadata = metadata, output = output, error = error))

class ToolRowsTest {
    @Test
    fun bash_shows_the_first_command_line_and_exit_code() {
        val row = ToolRows.row(tool("bash", input = buildJsonObject { put("command", "  bun test transcript\n  && echo done") }, metadata = buildJsonObject { put("exit", 0) }, output = "ok"))
        assertEquals("bun test transcript", row.primary)
        assertEquals("exit 0", row.secondary)
        assertTrue(row.mono)
        assertFalse(row.failed)
    }

    @Test
    fun bash_failure_carries_the_exit_code_and_error_output() {
        val row = ToolRows.row(tool("bash", status = "error", input = buildJsonObject { put("command", "make") }, metadata = buildJsonObject { put("exit", 2) }, output = "partial", error = "make: *** [all] Error 2"))
        assertEquals("exit 2", row.secondary)
        assertTrue(row.failed)
        assertEquals("make: *** [all] Error 2", row.output)
    }

    @Test
    fun bash_without_exit_falls_back_to_the_description() {
        val row = ToolRows.row(tool("bash", status = "running", input = buildJsonObject { put("command", "sleep 5"); put("description", "wait for build") }))
        assertEquals("wait for build", row.secondary)
        assertTrue(row.live)
    }

    @Test
    fun grep_shows_pattern_and_match_count() {
        val row = ToolRows.row(tool("grep", title = "packages/es-app", input = buildJsonObject { put("pattern", "deskBusy") }, metadata = buildJsonObject { put("matches", 3); put("truncated", false) }))
        assertEquals("deskBusy", row.primary)
        assertEquals("3 matches", row.secondary)
    }

    @Test
    fun grep_single_match_and_truncation_are_worded() {
        assertEquals("1 match", ToolRows.row(tool("grep", input = buildJsonObject { put("pattern", "x") }, metadata = buildJsonObject { put("matches", 1) })).secondary)
        assertEquals("40 matches (truncated)", ToolRows.row(tool("grep", input = buildJsonObject { put("pattern", "x") }, metadata = buildJsonObject { put("matches", 40); put("truncated", true) })).secondary)
    }

    @Test
    fun glob_shows_pattern_and_file_count() {
        val row = ToolRows.row(tool("glob", input = buildJsonObject { put("pattern", "**/*.kt") }, metadata = buildJsonObject { put("count", 12) }))
        assertEquals("**/*.kt", row.primary)
        assertEquals("12 files", row.secondary)
    }

    @Test
    fun read_uses_the_relative_title_and_window() {
        val row = ToolRows.row(tool("read", title = "packages/es-app/src/state.tsx", input = buildJsonObject { put("filePath", "/abs/packages/es-app/src/state.tsx"); put("offset", 120); put("limit", 40) }))
        assertEquals("packages/es-app/src/state.tsx", row.primary)
        assertEquals("from line 120 · 40 lines", row.secondary)
    }

    @Test
    fun edit_summarises_added_and_removed_lines_from_the_diff() {
        val diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n-old\n+new\n+more\n context\n"
        val row = ToolRows.row(tool("edit", title = "src/x.ts", metadata = buildJsonObject { put("diff", diff) }))
        assertEquals("src/x.ts", row.primary)
        assertEquals("+2 −1", row.secondary)
    }

    @Test
    fun edit_without_a_diff_has_no_summary() {
        assertNull(ToolRows.row(tool("edit", title = "src/x.ts")).secondary)
        assertNull(ToolRows.diffSummary("--- a\n+++ b\n"))
    }

    @Test
    fun write_distinguishes_new_file_from_replacement() {
        val fresh = ToolRows.row(tool("write", title = "README.md", input = buildJsonObject { put("content", "a\nb\nc") }, metadata = buildJsonObject { put("exists", false) }))
        assertEquals("new file · 3 lines", fresh.secondary)
        val replaced = ToolRows.row(tool("write", title = "README.md", input = buildJsonObject { put("content", "a") }, metadata = buildJsonObject { put("exists", true) }))
        assertEquals("replaced · 1 lines", replaced.secondary)
    }

    @Test
    fun task_shows_subagent_title_type_and_background() {
        val row = ToolRows.row(tool("task", status = "running", input = buildJsonObject { put("description", "Study manadj Android design"); put("subagent_type", "explore") }, metadata = buildJsonObject { put("background", true) }))
        assertEquals("Study manadj Android design", row.primary)
        assertEquals("explore · background", row.secondary)
        assertFalse(row.mono)
        assertTrue(row.live)
    }

    @Test
    fun webfetch_shows_host_then_path() {
        val row = ToolRows.row(tool("webfetch", input = buildJsonObject { put("url", "https://registry.terraform.io/v1/modules/DataDog/lambda-datadog/aws") }))
        assertEquals("registry.terraform.io", row.primary)
        assertEquals("/v1/modules/DataDog/lambda-datadog/aws", row.secondary)
    }

    @Test
    fun todowrite_shows_the_in_progress_item_and_count() {
        val row = ToolRows.row(tool("todowrite", input = buildJsonObject {
            putJsonArray("todos") {
                add(buildJsonObject { put("content", "done thing"); put("status", "completed") })
                add(buildJsonObject { put("content", "current thing"); put("status", "in_progress") })
            }
        }))
        assertEquals("current thing", row.primary)
        assertEquals("2 items", row.secondary)
    }

    @Test
    fun unknown_tool_falls_back_to_title_then_name() {
        assertEquals("Inspect child", ToolRows.row(tool("mcp_thing", title = "Inspect child")).primary)
        assertEquals("mcp_thing", ToolRows.row(tool("mcp_thing")).primary)
    }

    @Test
    fun pending_state_without_fields_is_live_and_harmless() {
        val row = ToolRows.row(Part(id = "p", type = "tool", tool = "bash", state = null))
        assertEquals("bash", row.primary)
        assertTrue(row.live)
        assertNull(row.output)
    }

    @Test
    fun consecutive_same_tool_calls_group_and_count_failures() {
        val parts = listOf(
            tool("bash", input = buildJsonObject { put("command", "a") }),
            tool("bash", status = "error", input = buildJsonObject { put("command", "b") }, error = "boom"),
            tool("read", title = "x.kt"),
            tool("read", title = "y.kt"),
            tool("bash", input = buildJsonObject { put("command", "c") }),
            Part(id = "t", type = "text", text = "ignored"),
        )
        val groups = ToolRows.groups(parts)
        assertEquals(listOf("bash", "read", "bash"), groups.map { it.tool })
        assertEquals(listOf(2, 2, 1), groups.map { it.rows.size })
        assertEquals(1, groups[0].failures)
        assertEquals("b", groups[0].rows.last().primary)
    }
}
