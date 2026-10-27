package ai.opencode.desk.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

// Shapes follow the verified loopback responses (see README "Contracts"). Every DTO is
// lenient: unknown keys are ignored and most fields are optional so a backend change
// degrades a row instead of crashing the app.

// ---- es dashboard (/es/api) ----

@Serializable
data class EditspacesResponse(val editspaces: List<EditspaceRef> = emptyList(), val default: String? = null)

@Serializable
data class EditspaceRef(val name: String, val root: String = "")

@Serializable
data class StateResponse(
    val editspace: String = "",
    val root: String = "",
    val generated_at: Double = 0.0,
    val tracker_error: String? = null,
    val threads: List<Thread> = emptyList(),
    val sessions: List<DashSession> = emptyList(),
    val attention: List<DigestAttention> = emptyList(),
)

@Serializable
data class Thread(
    val kind: String = "",
    val key: String = "",
    val title: String = "",
    val description: String = "",
    val curated_status: String? = null,
    val lanes: List<LaneRecord> = emptyList(),
    val sessions: List<DashSession> = emptyList(),
    val activity: Double? = null,
)

@Serializable
data class LaneRecord(
    val lane: String = "",
    val owner: String = "",
    val activity: String = "",
    val activity_at: String = "",
    val activity_session: String = "",
    val issue: String = "",
    val status: String = "",
    val dir: String = "",
    val repos: List<String> = emptyList(),
)

@Serializable
data class DashSession(
    val id: String,
    val title: String = "",
    val live: String = "idle",
    val updated: Double = 0.0,
    val cost: Double = 0.0,
    val directory: String = "",
)

@Serializable
data class DigestAttention(val rank: Int = 0, val type: String = "", val thread: String = "", val detail: String = "", val session: String? = null)

@Serializable
data class AttentionList(
    val records: List<AttentionRecord> = emptyList(),
    val projects: List<AttentionProject> = emptyList(),
    val partial: Boolean = false,
)

@Serializable
data class AttentionProject(val editspace: String, val available: Boolean = true, val observed_at: Long? = null, val error: String? = null)

@Serializable
data class OptionChoice(val id: String, val label: String = "")

// Declared by an option that is only actionable with data attached (es-attention.md "input").
@Serializable
data class OptionInput(
    val kind: String = "",
    val label: String = "",
    val required: Boolean = false,
    val hint: String? = null,
    val choices: List<OptionChoice> = emptyList(),
    val max: Int? = null,
)

@Serializable
data class AttentionOption(val id: String, val label: String = "", val input: OptionInput? = null)

@Serializable
data class AttentionAnswer(
    val id: String = "",
    val text: String = "",
    val choice_id: String? = null,
    // string for text/choice input, string[] for multi
    val input_value: JsonElement? = null,
    val answered_at: Long? = null,
)

@Serializable
data class AttentionDelivery(
    val state: String = "",
    val reason: String? = null,
    val lane: String? = null,
    val error: String? = null,
    val attempts: Int = 0,
)

@Serializable
data class SourceRef(val session_id: String? = null, val directory: String? = null)

@Serializable
data class AttentionRecord(
    val id: String,
    val kind: String = "decision",
    val status: String = "open",
    val title: String = "",
    val context: String = "",
    val editspace: String = "",
    val lane: String? = null,
    val gate_key: String = "",
    val options: List<AttentionOption> = emptyList(),
    val recommendation: String? = null,
    val producer_session: String? = null,
    val source_ref: SourceRef? = null,
    val delivery_state: String = "not-requested",
    val delivery: AttentionDelivery? = null,
    val decision: String? = null,
    val answer: AttentionAnswer? = null,
    val resolution: String? = null,
    val snoozed_until: Long? = null,
    val revision: Int = 0,
    val created_at: Long = 0,
    val updated_at: Long = 0,
)

@Serializable
data class AttentionDetail(val record: AttentionRecord, val events: List<AttentionEvent> = emptyList())

@Serializable
data class AttentionEvent(val revision: Int = 0, val at: Long = 0, val action: String = "", val actor: String? = null, val reason: String? = null)

@Serializable
data class AttentionCommandResponse(val record: AttentionRecord)

@Serializable
data class OperatorSession(val operator: Boolean = false, val answer: Boolean = false)

@Serializable
data class CurrentWork(val turn: CurrentTurn? = null, val summary: CurrentSummary? = null)

@Serializable
data class CurrentTurn(
    val started_at: Long? = null,
    val elapsed_seconds: Long = 0,
    val status: String = "",
    val user_messages: Int = 0,
    val assistant_messages: Int = 0,
    val tool_calls: Int = 0,
    val active_tools: List<String> = emptyList(),
)

@Serializable
data class CurrentSummary(val status: String = "unavailable", val text: String? = null, val generated_at: Long? = null)

// ---- OpenCode Core (/oc) ----

@Serializable
data class SessionTime(val created: Long = 0, val updated: Long = 0, val completed: Long? = null, val archived: Long? = null)

@Serializable
data class ModelRef(val id: String? = null, val providerID: String? = null, val modelID: String? = null)

@Serializable
data class SessionInfo(
    val id: String,
    val slug: String = "",
    val projectID: String = "",
    val directory: String = "",
    val title: String = "",
    val parentID: String? = null,
    val agent: String? = null,
    val cost: Double = 0.0,
    val model: ModelRef? = null,
    val time: SessionTime = SessionTime(),
    val metadata: JsonObject? = null,
)

@Serializable
data class SessionStatus(val type: String = "idle", val attempt: Int? = null, val message: String? = null)

@Serializable
data class MessageInfo(
    val id: String,
    val sessionID: String = "",
    val role: String = "",
    val agent: String? = null,
    val time: SessionTime = SessionTime(),
    val cost: Double? = null,
    val finish: String? = null,
    // Where a user message came from when not typed by the human. Kept raw and interpreted
    // by Provenance so a new server source type degrades to a labelled card, not a crash.
    val source: JsonObject? = null,
)

@Serializable
data class ToolState(
    val status: String = "pending",
    val title: String? = null,
    val output: String? = null,
    val error: String? = null,
    val input: JsonObject? = null,
    val metadata: JsonObject? = null,
    val time: SessionTime? = null,
)

// Part union discriminated on `type`; only the fields this client renders are declared.
@Serializable
data class Part(
    val id: String = "",
    val type: String = "",
    val text: String? = null,
    val tool: String? = null,
    val callID: String? = null,
    val state: ToolState? = null,
    val reason: String? = null,
    val cost: Double? = null,
    val metadata: JsonObject? = null,
)

@Serializable
data class MessageWithParts(val info: MessageInfo, val parts: List<Part> = emptyList())

@Serializable
data class InputReceipt(
    val requestID: String,
    val state: String = "pending",
    val delivery: String = "steer",
    val text: String = "",
    val agent: String? = null,
    val revision: Int = 0,
    val sessionID: String = "",
    val messageID: String? = null,
    val timeCreated: Long = 0,
    val timeHandled: Long? = null,
    // Same shape as MessageInfo.source: who admitted this input when it was not a human.
    val source: JsonObject? = null,
)

@Serializable
data class ReceiptPage(val items: List<InputReceipt> = emptyList(), val next: String? = null)

@Serializable
data class Todo(val content: String = "", val status: String = "pending", val priority: String = "medium")

@Serializable
data class AgentInfo(val name: String, val description: String? = null, val mode: String? = null, val hidden: Boolean? = null)

@Serializable
data class PermissionRequest(val id: String, val sessionID: String = "", val action: String = "", val resources: List<String> = emptyList())

@Serializable
data class QuestionItem(val question: String = "", val header: String? = null, val options: List<QuestionOption> = emptyList(), val multiple: Boolean? = null)

@Serializable
data class QuestionOption(val label: String = "", val description: String? = null)

@Serializable
data class QuestionRequest(val id: String, val sessionID: String = "", val questions: List<QuestionItem> = emptyList())

fun JsonObject.string(key: String) = (this[key] as? JsonElement)?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }
