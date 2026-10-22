package ai.opencode.desk

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.opencode.desk.model.AttentionProject
import ai.opencode.desk.model.AttentionRecord
import ai.opencode.desk.model.CurrentWork
import ai.opencode.desk.model.DashSession
import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.LaneRecord
import ai.opencode.desk.model.MessageWithParts
import ai.opencode.desk.model.StateResponse
import ai.opencode.desk.model.Todo
import ai.opencode.desk.net.Api
import ai.opencode.desk.net.Gateway
import ai.opencode.desk.net.GatewayError
import ai.opencode.desk.net.PairingRequired
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

enum class Link { Unpaired, Connecting, Online, Offline }

// One lane (or lone session) as the phone presents it: a named agent with a live status.
data class Agent(
    val key: String,
    val editspace: String,
    val lane: String,
    val title: String,
    val description: String,
    val status: String,
    val activity: String,
    val activityAt: Long,
    val issue: String,
    val session: DashSession?,
    val sessions: List<DashSession>,
) {
    val busy get() = status == "busy"
    val directory get() = session?.directory.orEmpty()
}

data class AgentDetail(
    val messages: List<MessageWithParts> = emptyList(),
    val todos: List<Todo> = emptyList(),
    val receipts: List<InputReceipt> = emptyList(),
    val work: CurrentWork? = null,
    val loadedAt: Long = 0,
    val error: String? = null,
)

class DeskStore(app: Application) : AndroidViewModel(app) {
    val gateway = Gateway(app)
    val api = Api(gateway)
    private val prefs = app.getSharedPreferences("desk", Context.MODE_PRIVATE)

    var link by mutableStateOf(if (gateway.paired) Link.Connecting else Link.Unpaired)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set
    var updatedAt by mutableStateOf(0L)
        private set
    var now by mutableStateOf(System.currentTimeMillis())
        private set

    var editspaces by mutableStateOf<List<String>>(emptyList())
        private set
    var projects by mutableStateOf<List<AttentionProject>>(emptyList())
        private set
    val states = mutableStateMapOf<String, StateResponse>()
    var open by mutableStateOf<List<AttentionRecord>>(emptyList())
        private set
    var snoozed by mutableStateOf<List<AttentionRecord>>(emptyList())
        private set
    var history by mutableStateOf<List<AttentionRecord>>(emptyList())
        private set
    var agents by mutableStateOf<List<Agent>>(emptyList())
        private set
    var operator by mutableStateOf(false)
        private set

    // Project filter persists across launches; empty = all projects.
    var filter by mutableStateOf<Set<String>>(prefs.getStringSet("filter", emptySet())?.filterNotNull()?.toSet() ?: emptySet())
        private set

    val details = mutableStateMapOf<String, AgentDetail>()
    val deskMessages = mutableStateMapOf<String, List<MessageWithParts>>()
    val deskReceipts = mutableStateMapOf<String, List<InputReceipt>>()

    val nudges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private var loop: Job? = null
    private var events: Job? = null

    init {
        if (gateway.paired) connect()
        viewModelScope.launch { while (isActive) { now = System.currentTimeMillis(); delay(10_000) } }
    }

    fun filterProjects(value: Set<String>) {
        filter = value
        prefs.edit().putStringSet("filter", value).apply()
    }

    val filteredOpen get() = open.filter { filter.isEmpty() || it.editspace in filter }
    val filteredAgents get() = agents.filter { filter.isEmpty() || it.editspace in filter }

    // ---- connection ----

    suspend fun pair(origin: String, code: String): String? {
        gateway.origin = origin
        return runCatching { gateway.pair(code) }.fold(
            onSuccess = { ok -> if (ok) { connect(); null } else "That code was not accepted." },
            onFailure = { it.message ?: "Could not reach the gateway." },
        )
    }

    fun unpair() {
        loop?.cancel(); events?.cancel()
        gateway.forget()
        states.clear(); open = emptyList(); agents = emptyList()
        link = Link.Unpaired
    }

    fun connect() {
        link = Link.Connecting
        loop?.cancel()
        loop = viewModelScope.launch {
            while (isActive) {
                refresh()
                // Nudges from the dashboard event stream shorten the wait; otherwise poll.
                withTimeoutOrNull(if (link == Link.Online) 20_000 else 5_000) { nudges.first() }
            }
        }
        events?.cancel()
        events = viewModelScope.launch(Dispatchers.IO) {
            var backoff = 1_000L
            while (isActive) {
                runCatching {
                    gateway.stream("/es/api/notification-events") { data -> if (data != "connected") nudges.tryEmit(Unit) }
                }.onFailure { if (it is PairingRequired) { link = Link.Unpaired; return@launch } }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000)
            }
        }
    }

    suspend fun refresh() {
        try {
            coroutineScope {
                val spaces = async { api.editspaces() }
                val openList = async { api.attention("open") }
                val snoozedList = async { api.attention("snoozed") }
                val historyList = async { api.attention("history", limit = 60) }
                val session = async { runCatching { api.operator() }.getOrNull() }
                val names = spaces.await().editspaces.map { it.name }
                editspaces = names
                val loaded = names.map { name -> async { name to runCatching { api.state(name) }.getOrNull() } }.awaitAll()
                loaded.forEach { (name, state) -> if (state != null) states[name] = state }
                val attention = openList.await()
                open = attention.records.sortedWith(compareBy({ it.kind != "blocker" }, { -it.updated_at }))
                projects = attention.projects
                snoozed = snoozedList.await().records
                history = historyList.await().records.sortedByDescending { it.updated_at }
                operator = session.await()?.operator == true
                agents = deriveAgents()
            }
            updatedAt = System.currentTimeMillis()
            lastError = null
            link = Link.Online
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: PairingRequired) {
            link = Link.Unpaired
        } catch (error: Exception) {
            Log.w("Desk", "refresh failed: ${error.javaClass.simpleName}: ${error.message}")
            lastError = error.message
            link = Link.Offline
        }
    }

    private fun deriveAgents(): List<Agent> = states.flatMap { (es, state) ->
        val fromLanes = state.threads.flatMap { thread ->
            thread.lanes.map { lane ->
                val sessions = thread.sessions.sortedByDescending { it.updated }
                val head = sessions.firstOrNull { it.id == lane.activity_session || it.id == lane.owner } ?: sessions.firstOrNull()
                Agent(
                    key = "$es/${lane.lane}",
                    editspace = es,
                    lane = lane.lane,
                    title = thread.title.ifBlank { lane.lane },
                    description = thread.description,
                    status = when {
                        sessions.any { it.live == "busy" } -> "busy"
                        lane.status == "parked" || lane.activity.startsWith("parked") -> "parked"
                        else -> "idle"
                    },
                    // The session title usually repeats the thread title; fall back to the lane name instead.
                    activity = lane.activity.ifBlank { head?.title?.takeIf { it != thread.title } ?: lane.lane },
                    activityAt = parseIso(lane.activity_at) ?: head?.updated?.toLong() ?: 0L,
                    issue = lane.issue,
                    session = head,
                    sessions = sessions,
                )
            }
        }
        fromLanes
    }.sortedWith(compareBy({ !it.busy }, { -it.activityAt }))

    // ---- attention actions ----
    // Every write goes through the operator session; a 401 means the 8 h cookie lapsed.
    private suspend fun <T> asOperator(block: suspend () -> T): T {
        if (!operator) { api.bootstrapOperator(); operator = true }
        return try { block() } catch (error: GatewayError) {
            if (error.code != 401) throw error
            api.bootstrapOperator(); operator = true
            block()
        }
    }

    suspend fun act(record: AttentionRecord, action: suspend Api.(AttentionRecord) -> AttentionRecord): Result<AttentionRecord> =
        runCatching { asOperator { api.action(record) } }.onSuccess { updated ->
            open = open.map { if (it.id == updated.id) updated else it }.filter { it.status == "open" }
            nudges.tryEmit(Unit)
        }

    // ---- agent detail ----
    fun load(agent: Agent) {
        val session = agent.session ?: return
        viewModelScope.launch {
            val detail = runCatching {
                coroutineScope {
                    val messages = async { api.messages(session.id, session.directory, 30) }
                    val todos = async { runCatching { api.todos(session.id, session.directory) }.getOrDefault(emptyList()) }
                    val receipts = async { runCatching { api.receipts(session.id, session.directory).items }.getOrDefault(emptyList()) }
                    val work = async { runCatching { api.currentWork(session.id, session.directory) }.getOrNull() }
                    AgentDetail(messages.await(), todos.await(), receipts.await(), work.await(), System.currentTimeMillis())
                }
            }.getOrElse { AgentDetail(error = it.message, loadedAt = System.currentTimeMillis()) }
            details[agent.key] = detail
        }
    }

    suspend fun steer(agent: Agent, text: String, delivery: String): Result<InputReceipt> {
        val session = agent.session ?: return Result.failure(IllegalStateException("No session"))
        return runCatching { api.input(session.id, session.directory, text, delivery) }.onSuccess { load(agent) }
    }

    suspend fun stop(agent: Agent): Result<Boolean> {
        val session = agent.session ?: return Result.failure(IllegalStateException("No session"))
        return runCatching { api.abort(session.id, session.directory) }.onSuccess { nudges.tryEmit(Unit) }
    }

    suspend fun cancel(agent: Agent, receipt: InputReceipt): Result<Unit> {
        val session = agent.session ?: return Result.failure(IllegalStateException("No session"))
        return runCatching { api.cancelInput(session.id, session.directory, receipt.requestID) }.onSuccess { load(agent) }
    }

    // ---- front desk ----
    // The desk is a plain Core session with agent `front-desk`, one per gateway, created
    // lazily with a client-chosen id so a lost response never duplicates it.
    val deskDirectory: String? get() = states.values.firstOrNull { it.editspace == deskSpace }?.root ?: states.values.firstOrNull()?.root
    val deskSpace: String get() = prefs.getString("desk.space", null) ?: editspaces.firstOrNull { it == "opencode" } ?: editspaces.firstOrNull().orEmpty()
    val deskID: String get() = prefs.getString("desk.id", null) ?: "ses_desk_${UUID.randomUUID().toString().replace("-", "").take(20)}".also { prefs.edit().putString("desk.id", it).apply() }
    val deskReady get() = prefs.getBoolean("desk.ready", false)

    suspend fun ensureDesk(): Result<String> {
        val directory = deskDirectory ?: return Result.failure(IllegalStateException("No editspace root yet"))
        if (deskReady) return Result.success(deskID)
        return runCatching { api.createSession(directory, deskID, "Desk (phone)", "front-desk").id }
            .onSuccess { prefs.edit().putBoolean("desk.ready", true).apply() }
    }

    fun loadDesk() {
        val directory = deskDirectory ?: return
        if (!deskReady) return
        viewModelScope.launch {
            runCatching { api.messages(deskID, directory, 60) }.onSuccess { deskMessages[deskID] = it }
            runCatching { api.receipts(deskID, directory).items }.onSuccess { deskReceipts[deskID] = it.filter { r -> r.state == "pending" || r.state == "promoted" } }
        }
    }

    suspend fun askDesk(text: String): Result<InputReceipt> {
        val directory = deskDirectory ?: return Result.failure(IllegalStateException("No editspace root yet"))
        return ensureDesk().mapCatching { id -> api.input(id, directory, text, "queue") }.onSuccess { loadDesk() }
    }

    val deskBusy: Boolean get() = states.values.flatMap { it.sessions }.any { it.id == deskID && it.live == "busy" }
}

fun parseIso(value: String): Long? = runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
