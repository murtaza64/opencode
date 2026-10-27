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
import ai.opencode.desk.net.AccessRequired
import ai.opencode.desk.net.AccessToken
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

enum class Link { Unpaired, Connecting, Online, Offline, Access }

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
    // Cursor for the page older than `messages`; null once the whole history is loaded.
    val cursor: String? = null,
    val loadingOlder: Boolean = false,
)

// Newest page replaces the tail; pages the user already scrolled back through are kept in front.
fun mergeNewest(existing: List<MessageWithParts>, page: List<MessageWithParts>): List<MessageWithParts> {
    if (page.isEmpty()) return existing
    val ids = page.map { it.info.id }.toSet()
    val oldest = page.first().info.time.created
    return existing.filter { it.info.id !in ids && it.info.time.created < oldest } + page
}

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

    // The service token is stored before pairing so the pair request itself carries it.
    suspend fun pair(origin: String, code: String, access: AccessToken?): String? {
        gateway.origin = origin
        desk = pointers.get(origin)
        if (access != null) gateway.saveAccessToken(access)
        return runCatching { gateway.pair(code) }.fold(
            onSuccess = { ok -> if (ok) { connect(); null } else "That code was not accepted." },
            onFailure = {
                if (it is AccessRequired) "This server is behind Cloudflare Access. Add the Access service token (client ID and secret) and pair again."
                else it.message ?: "Could not reach the gateway."
            },
        )
    }

    fun unpair() {
        loop?.cancel(); events?.cancel()
        gateway.forget()
        states.clear(); open = emptyList(); agents = emptyList()
        desk = null; deskBusy = false
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
                }.onFailure {
                    if (it is PairingRequired) { link = Link.Unpaired; return@launch }
                    if (it is AccessRequired) link = Link.Access
                }
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
        } catch (error: AccessRequired) {
            lastError = error.message
            link = Link.Access
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
            val previous = details[agent.key]
            val detail = runCatching {
                coroutineScope {
                    val page = async { api.page(session.id, session.directory, 30, null) }
                    val todos = async { runCatching { api.todos(session.id, session.directory) }.getOrDefault(emptyList()) }
                    val receipts = async { runCatching { api.receipts(session.id, session.directory).items }.getOrDefault(emptyList()) }
                    val work = async { runCatching { api.currentWork(session.id, session.directory) }.getOrNull() }
                    val newest = page.await()
                    val older = previous?.messages.orEmpty()
                    AgentDetail(
                        messages = mergeNewest(older, newest.items),
                        todos = todos.await(), receipts = receipts.await(), work = work.await(), loadedAt = System.currentTimeMillis(),
                        // Keep the deeper cursor when older pages are already loaded.
                        cursor = if (previous != null && older.size > newest.items.size) previous.cursor else newest.cursor,
                    )
                }
            }.getOrElse { AgentDetail(error = it.message, loadedAt = System.currentTimeMillis(), messages = previous?.messages.orEmpty(), cursor = previous?.cursor) }
            details[agent.key] = detail
        }
    }

    fun loadOlder(agent: Agent) {
        val session = agent.session ?: return
        val detail = details[agent.key] ?: return
        val cursor = detail.cursor ?: return
        if (detail.loadingOlder) return
        details[agent.key] = detail.copy(loadingOlder = true)
        viewModelScope.launch {
            val page = runCatching { api.page(session.id, session.directory, 40, cursor) }.getOrNull()
            val current = details[agent.key] ?: return@launch
            details[agent.key] = if (page == null) current.copy(loadingOlder = false)
            else current.copy(messages = page.items + current.messages.filter { m -> page.items.none { it.info.id == m.info.id } }, cursor = page.cursor, loadingOlder = false)
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
    // lazily with a client-chosen id so a lost response never duplicates it. The pointer
    // (id + pinned directory) is keyed by gateway origin; see DeskPointers.
    private val pointers = DeskPointers(object : KeyValue {
        override fun get(key: String) = prefs.getString(key, null)
        override fun put(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
    })
    var desk by mutableStateOf(pointers.get(gateway.origin))
        private set
    var deskBusy by mutableStateOf(false)
        private set
    val deskID: String get() = desk?.id ?: "none"
    val deskSpace: String get() = desk?.space.orEmpty()
    val deskReady: Boolean get() = desk?.ready == true

    // Preferred editspace for a new desk: "opencode" when the host has it, else the first one.
    private fun pickDeskRoot(): Pair<String, String>? {
        val space = editspaces.firstOrNull { it == "opencode" } ?: editspaces.firstOrNull() ?: return null
        val root = states[space]?.root ?: return null
        return space to root
    }

    suspend fun ensureDesk(): Result<DeskPointer> {
        val existing = pointers.get(gateway.origin)
        if (existing?.ready == true) { desk = existing; return Result.success(existing) }
        val pointer = existing ?: run {
            val (space, root) = pickDeskRoot() ?: return Result.failure(IllegalStateException("No editspace root yet"))
            pointers.create(gateway.origin, space, root)
        }
        desk = pointer
        return runCatching { api.createSession(pointer.directory, pointer.id, "Desk (phone)", "front-desk") }
            .map { pointers.markReady(gateway.origin)!!.also { desk = it } }
    }

    val deskCursors = mutableStateMapOf<String, String?>()
    private var deskLoadingOlder = false

    fun loadDesk() {
        val pointer = pointers.get(gateway.origin)?.takeIf { it.ready } ?: return
        desk = pointer
        viewModelScope.launch {
            runCatching { api.page(pointer.id, pointer.directory, 40, null) }.onSuccess { page ->
                val older = deskMessages[pointer.id].orEmpty()
                deskMessages[pointer.id] = mergeNewest(older, page.items)
                if (older.size <= page.items.size || !deskCursors.containsKey(pointer.id)) deskCursors[pointer.id] = page.cursor
            }
            runCatching { api.receipts(pointer.id, pointer.directory).items }.onSuccess { deskReceipts[pointer.id] = it.filter { r -> r.state == "pending" || r.state == "promoted" } }
            // Core status, not the dashboard list: the desk session is not in any lane.
            runCatching { api.status(pointer.directory)[pointer.id]?.type == "busy" }.onSuccess { deskBusy = it }
        }
    }

    fun loadOlderDesk() {
        val pointer = desk?.takeIf { it.ready } ?: return
        val cursor = deskCursors[pointer.id] ?: return
        if (deskLoadingOlder) return
        deskLoadingOlder = true
        viewModelScope.launch {
            runCatching { api.page(pointer.id, pointer.directory, 40, cursor) }.onSuccess { page ->
                val current = deskMessages[pointer.id].orEmpty()
                deskMessages[pointer.id] = page.items + current.filter { m -> page.items.none { it.info.id == m.info.id } }
                deskCursors[pointer.id] = page.cursor
            }
            deskLoadingOlder = false
        }
    }

    suspend fun askDesk(text: String): Result<InputReceipt> =
        ensureDesk().mapCatching { pointer -> api.input(pointer.id, pointer.directory, text, "queue") }.onSuccess { loadDesk() }
}

fun parseIso(value: String): Long? = runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
