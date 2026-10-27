package ai.opencode.desk

import ai.opencode.desk.model.Part
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

// One tool call as a phone row: what it did (primary), the one number or state that matters
// (secondary) and the status. Built only from fields the tool part already carries.
data class ToolRow(
    val tool: String,
    val primary: String,
    val secondary: String?,
    val status: String,
    val output: String?,
    val mono: Boolean,
) {
    val failed get() = status == "error"
    val live get() = status == "running" || status == "pending"
}

// Consecutive calls of the same tool, folded by the UI when there are several.
data class ToolGroup(val tool: String, val rows: List<ToolRow>) {
    val failures get() = rows.count { it.failed }
    val live get() = rows.any { it.live }
}

object ToolRows {
    private fun JsonObject?.text(key: String) = (this?.get(key) as? JsonPrimitive)?.contentOrNull
    private fun JsonObject?.int(key: String) = (this?.get(key) as? JsonPrimitive)?.intOrNull
    private fun String.firstLine() = lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()

    fun row(part: Part): ToolRow {
        val state = part.state
        val input = state?.input
        val meta = state?.metadata
        val tool = part.tool.orEmpty()
        val title = state?.title?.takeIf { it.isNotBlank() }
        val status = state?.status ?: "pending"
        val output = state?.error ?: state?.output
        val (primary, secondary, mono) = when (tool) {
            "bash" -> Triple(
                input.text("command")?.firstLine() ?: title ?: "bash",
                meta.int("exit")?.let { if (it == 0) "exit 0" else "exit $it" } ?: input.text("description"),
                true,
            )
            "read" -> Triple(
                title ?: input.text("filePath")?.substringAfterLast('/') ?: "read",
                input.int("offset")?.let { offset -> "from line $offset" + (input.int("limit")?.let { " · $it lines" } ?: "") },
                true,
            )
            "grep" -> Triple(
                input.text("pattern") ?: title ?: "grep",
                meta.int("matches")?.let { "$it ${if (it == 1) "match" else "matches"}" + (meta.text("truncated")?.takeIf { t -> t == "true" }?.let { " (truncated)" } ?: "") },
                true,
            )
            "glob" -> Triple(
                input.text("pattern") ?: title ?: "glob",
                meta.int("count")?.let { "$it ${if (it == 1) "file" else "files"}" },
                true,
            )
            "edit" -> Triple(
                title ?: input.text("filePath")?.substringAfterLast('/') ?: "edit",
                meta.text("diff")?.let(::diffSummary),
                true,
            )
            "write" -> Triple(
                title ?: input.text("filePath")?.substringAfterLast('/') ?: "write",
                listOfNotNull(
                    meta.text("exists")?.let { if (it == "true") "replaced" else "new file" },
                    input.text("content")?.let { "${it.lines().size} lines" },
                ).joinToString(" · ").ifBlank { null },
                true,
            )
            "task" -> Triple(
                input.text("description") ?: title ?: "task",
                listOfNotNull(input.text("subagent_type"), meta.text("background")?.takeIf { it == "true" }?.let { "background" }).joinToString(" · ").ifBlank { null },
                false,
            )
            "webfetch" -> {
                val url = input.text("url").orEmpty()
                val host = url.substringAfter("://").substringBefore('/')
                val path = url.substringAfter("://").substringAfter('/', "").let { if (it.isBlank()) null else "/" + it.take(48) }
                Triple(host.ifBlank { title ?: "webfetch" }, path, true)
            }
            "todowrite" -> {
                val todos = input?.get("todos") as? JsonArray
                val active = todos?.map { it as JsonObject }?.firstOrNull { it.text("status") == "in_progress" }?.text("content")
                Triple(active ?: "plan updated", todos?.let { "${it.size} items" }, false)
            }
            else -> Triple(title ?: tool.ifBlank { "tool" }, null, false)
        }
        return ToolRow(tool, primary, secondary, status, output, mono)
    }

    // "+12 −3" from a unified diff, ignoring the file headers.
    fun diffSummary(diff: String): String? {
        var added = 0
        var removed = 0
        diff.lineSequence().forEach { line ->
            when {
                line.startsWith("+++") || line.startsWith("---") -> Unit
                line.startsWith("+") -> added++
                line.startsWith("-") -> removed++
            }
        }
        if (added == 0 && removed == 0) return null
        return "+$added −$removed"
    }

    fun groups(parts: List<Part>): List<ToolGroup> =
        parts.filter { it.type == "tool" }.fold(mutableListOf<MutableList<Part>>()) { acc, part ->
            if (acc.lastOrNull()?.first()?.tool == part.tool) acc.last().add(part) else acc.add(mutableListOf(part))
            acc
        }.map { run -> ToolGroup(run.first().tool.orEmpty(), run.map(::row)) }
}
