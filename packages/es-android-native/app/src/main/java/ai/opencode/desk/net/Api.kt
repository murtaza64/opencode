package ai.opencode.desk.net

import ai.opencode.desk.model.AgentInfo
import ai.opencode.desk.model.AttentionCommandResponse
import ai.opencode.desk.model.AttentionDetail
import ai.opencode.desk.model.AttentionList
import ai.opencode.desk.model.AttentionRecord
import ai.opencode.desk.model.CurrentWork
import ai.opencode.desk.model.EditspacesResponse
import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.OperatorSession
import ai.opencode.desk.model.PermissionRequest
import ai.opencode.desk.model.QuestionRequest
import ai.opencode.desk.model.ReceiptPage
import ai.opencode.desk.model.SessionInfo
import ai.opencode.desk.model.SessionStatus
import ai.opencode.desk.model.StateResponse
import ai.opencode.desk.Surface
import ai.opencode.desk.SurfaceAddress
import ai.opencode.desk.SurfacesResponse
import ai.opencode.desk.model.Todo
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.UUID

data class MessagePage(val items: List<MessageWithParts>, val cursor: String?)

// Typed calls over the gateway. Paths are exactly the allowlisted ones in es-desktop policy.ts.
class Api(val gateway: Gateway) {
    private inline fun <reified T> parse(text: String): T = json.decodeFromString(text)

    // ---- dashboard reads ----
    suspend fun editspaces(): EditspacesResponse = parse(gateway.get("/es/api/editspaces"))
    suspend fun state(es: String): StateResponse = parse(gateway.get("/es/api/state", mapOf("es" to es)))
    suspend fun attention(view: String = "open", es: String? = null, limit: Int = 200): AttentionList =
        parse(gateway.get("/es/api/attention", mapOf("view" to view, "es" to es, "limit" to limit.toString())))
    suspend fun attentionDetail(id: String, es: String): AttentionDetail =
        parse(gateway.get("/es/api/attention/$id", mapOf("es" to es)))
    suspend fun operator(): OperatorSession = parse(gateway.get("/es/api/attention/session"))
    suspend fun currentWork(sessionID: String, directory: String): CurrentWork =
        parse(gateway.get("/es/api/current-work", mapOf("session_id" to sessionID, "directory" to directory)))

    // ---- surfaces (read-only) ----
    suspend fun surfaces(): SurfacesResponse = parse(gateway.get("/es/api/surfaces"))
    suspend fun surfaceAddress(id: String): SurfaceAddress = parse(gateway.get("/__es/surface/$id"))

    // ---- dashboard writes (attention) ----
    // The operator cookie lasts 8 h; callers re-bootstrap on 401 and retry once.
    suspend fun bootstrapOperator(): OperatorSession = parse(gateway.post("/es/api/attention/session", "{}"))

    // commandID is stable per draft so a retry after a lost response is the same command.
    suspend fun command(record: AttentionRecord, action: String, extra: JsonObject = JsonObject(emptyMap()), commandID: String = UUID.randomUUID().toString()): AttentionRecord {
        val body = buildJsonObject {
            put("command_id", commandID)
            put("expected_revision", record.revision)
            put("action", action)
            extra.forEach { (key, value) -> put(key, value) }
        }
        return parse<AttentionCommandResponse>(
            gateway.post("/es/api/attention/${record.id}/commands", body.toString(), mapOf("es" to record.editspace)),
        ).record
    }

    // Raw command body (built by AttentionInput.answerBody) so a retry resends identical bytes.
    suspend fun commandRaw(record: AttentionRecord, body: JsonObject): AttentionRecord =
        parse<AttentionCommandResponse>(gateway.post("/es/api/attention/${record.id}/commands", body.toString(), mapOf("es" to record.editspace))).record

    suspend fun choose(record: AttentionRecord, choice: String) =
        command(record, "choose", buildJsonObject { put("choice_id", choice) })

    suspend fun answer(record: AttentionRecord, text: String, choice: String?, inputValue: JsonElement? = null, commandID: String = UUID.randomUUID().toString()) =
        command(record, "answer", buildJsonObject {
            put("text", text)
            if (choice != null) put("choice_id", choice)
            if (inputValue != null) put("input_value", inputValue)
        }, commandID)

    suspend fun snooze(record: AttentionRecord, until: Long) =
        command(record, "snooze", buildJsonObject { put("snoozed_until", until) })

    suspend fun wake(record: AttentionRecord) = command(record, "wake")

    suspend fun resolve(record: AttentionRecord, reason: String) =
        command(record, "resolve", buildJsonObject { put("reason", reason) })

    // ---- Core reads ----
    suspend fun sessions(directory: String? = null, limit: Int = 200): List<SessionInfo> =
        json.decodeFromString(ListSerializer(SessionInfo.serializer()), gateway.get("/oc/session", mapOf("directory" to directory, "limit" to limit.toString())))
    suspend fun session(id: String, directory: String): SessionInfo =
        parse(gateway.get("/oc/session/$id", mapOf("directory" to directory)))
    suspend fun status(directory: String? = null): Map<String, SessionStatus> =
        json.decodeFromString(MapSerializer(String.serializer(), SessionStatus.serializer()), gateway.get("/oc/session/status", mapOf("directory" to directory)))
    suspend fun messages(id: String, directory: String, limit: Int = 40): List<MessageWithParts> = page(id, directory, limit, null).items

    // One page, newest first within the window. `before` is the cursor from a previous page;
    // the server advertises the next one in X-Next-Cursor when older messages exist.
    suspend fun page(id: String, directory: String, limit: Int, before: String?): MessagePage {
        val (body, next) = gateway.getWithHeader("/oc/session/$id/message", "X-Next-Cursor", mapOf("directory" to directory, "limit" to limit.toString(), "before" to before))
        return MessagePage(json.decodeFromString(ListSerializer(MessageWithParts.serializer()), body), next)
    }
    suspend fun todos(id: String, directory: String): List<Todo> =
        json.decodeFromString(ListSerializer(Todo.serializer()), gateway.get("/oc/session/$id/todo", mapOf("directory" to directory)))
    suspend fun receipts(id: String, directory: String): ReceiptPage =
        parse(gateway.get("/oc/session/$id/input", mapOf("directory" to directory, "limit" to "50")))
    suspend fun agents(): List<AgentInfo> = json.decodeFromString(ListSerializer(AgentInfo.serializer()), gateway.get("/oc/agent"))
    suspend fun permissions(): List<PermissionRequest> =
        json.decodeFromString(ListSerializer(PermissionRequest.serializer()), gateway.get("/oc/permission"))
    suspend fun questions(): List<QuestionRequest> =
        json.decodeFromString(ListSerializer(QuestionRequest.serializer()), gateway.get("/oc/question"))

    // ---- Core writes ----
    // Durable, idempotent input: a stable requestID makes retries safe.
    suspend fun input(id: String, directory: String, text: String, delivery: String, agent: String? = null, requestID: String = UUID.randomUUID().toString(), images: JsonArray? = null): InputReceipt {
        val body = buildJsonObject {
            put("requestID", requestID)
            put("delivery", delivery)
            put("text", text)
            if (agent != null) put("agent", agent)
            if (images != null && images.isNotEmpty()) put("images", images)
        }
        return parse(gateway.post("/oc/session/$id/input", body.toString(), mapOf("directory" to directory)))
    }

    suspend fun cancelInput(id: String, directory: String, requestID: String) {
        gateway.delete("/oc/session/$id/input/$requestID", mapOf("directory" to directory))
    }

    suspend fun abort(id: String, directory: String): Boolean =
        gateway.post("/oc/session/$id/abort", "{}", mapOf("directory" to directory)).trim() == "true"

    // Client-chosen id: re-POSTing the same id adopts the existing session (no duplicates on retry).
    suspend fun createSession(directory: String, id: String, title: String, agent: String?): SessionInfo {
        val body = buildJsonObject {
            put("id", id)
            put("title", title)
            if (agent != null) put("agent", agent)
        }
        return parse(gateway.post("/oc/session", body.toString(), mapOf("directory" to directory)))
    }

    suspend fun replyPermission(id: String, reply: String) {
        gateway.post("/oc/permission/$id/reply", buildJsonObject { put("reply", reply) }.toString())
    }

    suspend fun replyQuestion(id: String, answers: List<List<String>>) {
        gateway.post("/oc/question/$id/reply", buildJsonObject {
            putJsonArray("answers") { answers.forEach { group -> add(kotlinx.serialization.json.JsonArray(group.map { JsonPrimitive(it) })) } }
        }.toString())
    }
}
