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
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.UUID
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
    val profiles = ProfileBridge(app)
    var profileSwitch by mutableStateOf(Profiles.decide(profiles.current, profiles.targets()))
        private set
    fun refreshProfiles() { profileSwitch = Profiles.decide(profiles.current, profiles.targets()) }
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
    var surfaces by mutableStateOf<List<Surface>>(emptyList())
        private set
    // Notification reconciler state: the device ledger (tag → stamp) persisted per phone, and
    // a deep link waiting to be shown once the record is loaded.
    private val notifier = Notifier(app)
    private var ledger: Map<String, Int> = prefs.getString("notify.ledger", null)
        ?.let { runCatching { ai.opencode.desk.net.json.decodeFromString(MapSerializer(String.serializer(), Int.serializer()), it) }.getOrNull() }.orEmpty()
    var deepLink by mutableStateOf<Reconciler.Target?>(null)
    var deepLinkRevision by mutableStateOf<Int?>(null)
    var notificationsError by mutableStateOf<String?>(null)
        private set
    var surfacesError by mutableStateOf<String?>(null)
        private set

    // Project filter persists across launches; empty = all projects.
    var filter by mutableStateOf<Set<String>>(prefs.getStringSet("filter", emptySet())?.filterNotNull()?.toSet() ?: emptySet())
        private set

    val details = mutableStateMapOf<String, AgentDetail>()
    // Inputs this phone sent, by session, from tap to handled (see Outbox).
    val outbox = mutableStateMapOf<String, List<Pending>>()
    private val kv = object : KeyValue {
        override fun get(key: String) = prefs.getString(key, null)
        override fun put(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
    }
    // Message ids of this phone's own sends, persisted so "you" survives a restart.
    private val sent = SentLedger(kv)
    // Durable sends (text + normalised image bytes) so a kill mid-send can be retried verbatim.
    val blobs = FileBlobStore(app.filesDir)
    private val durable = OutboxStore(kv, blobs)
    private val pinStore = PinStore(kv)
    var pins by mutableStateOf(pinStore.list(gateway.origin))
        private set
    // Images picked for the next send, per session, already normalised and stored under a
    // reserved requestID so the send can be retried byte-for-byte.
    val drafts = mutableStateMapOf<String, ImageDraft>()
    data class ImageDraft(val requestID: String, val images: List<StoredImage>)
    val mine = mutableStateMapOf<String, Set<String>>()
    private fun remember(sessionID: String, items: List<Pending>) {
        items.filter { it.author == null && it.messageID != null }.forEach { sent.record(sessionID, it.messageID!!) }
        mine[sessionID] = sent.mine(sessionID)
    }
    val deskMessages = mutableStateMapOf<String, List<MessageWithParts>>()
    val deskReceipts = mutableStateMapOf<String, List<InputReceipt>>()

    val nudges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private var loop: Job? = null
    private var events: Job? = null

    init {
        restoreOutbox()
        if (gateway.paired) connect()
        viewModelScope.launch { while (isActive) { now = System.currentTimeMillis(); delay(10_000) } }
    }

    fun filterProjects(value: Set<String>) {
        filter = value
        prefs.edit().putStringSet("filter", value).apply()
    }

    val filteredOpen get() = open.filter { filter.isEmpty() || it.editspace in filter }
    val filteredAgents get() = agents.filter { filter.isEmpty() || it.editspace in filter }

    // Entries composed for this origin come back as Uncertain: the POST may or may not have
    // landed before the process died, and the same requestID makes the retry safe either way.
    private fun restoreOutbox() {
        durable.list(gateway.origin).forEach { entry ->
            val item = Pending(entry.requestID, entry.sessionID, entry.text, entry.delivery, SendState.Uncertain, error = "app restarted", createdAt = entry.createdAt, images = entry.images.size)
            outbox[entry.sessionID] = outbox[entry.sessionID].orEmpty().filter { it.requestID != entry.requestID } + item
        }
    }

    // ---- connection ----

    // The service token is stored before pairing so the pair request itself carries it.
    suspend fun pair(origin: String, code: String, access: AccessToken?): String? {
        gateway.origin = origin
        desk = pointers.get(origin)
        pins = pinStore.list(origin)
        outbox.clear(); drafts.clear()
        restoreOutbox()
        if (access != null) gateway.saveAccessToken(access)
        return runCatching { gateway.pair(code) }.fold(
            onSuccess = { ok -> if (ok) { connect(); null } else "That code was not accepted." },
            onFailure = {
                if (it is AccessRequired) "This server is behind Cloudflare Access. Add the Access service token (client ID and secret) and pair again."
                else it.message ?: "Could not reach the gateway."
            },
        )
    }

    // Switch to another saved (already paired) origin without a code.
    fun switchOrigin(origin: String) {
        loop?.cancel(); events?.cancel()
        gateway.origin = origin
        gateway.credentials.touch(origin)
        states.clear(); open = emptyList(); agents = emptyList(); surfaces = emptyList()
        desk = pointers.get(origin); deskBusy = false
        pins = pinStore.list(origin)
        outbox.clear(); drafts.clear()
        restoreOutbox()
        if (gateway.paired) connect() else link = Link.Unpaired
    }

    fun unpair() {
        loop?.cancel(); events?.cancel()
        gateway.forget()
        states.clear(); open = emptyList(); agents = emptyList(); surfaces = emptyList()
        desk = null; deskBusy = false
        outbox.clear(); drafts.clear(); pins = emptyList()
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
                // Surfaces are optional: an older gateway without the route leaves the section empty.
                val boards = async { runCatching { api.surfaces() } }
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
                boards.await().fold({ surfaces = it.surfaces.sortedWith(compareBy({ !it.unseen }, { -it.updated_at })); surfacesError = null }, { surfacesError = it.message })
                // One reconcile per refresh, over this origin only; all sources (nudge, poll, resume) land here.
                val requests = runCatching { api.notifications().notifications }.onFailure { notificationsError = it.message }.getOrDefault(emptyList())
                reconcileNotifications(attention.records + snoozedList.await().records + historyList.await().records, requests)
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

    private fun reconcileNotifications(records: List<AttentionRecord>, requests: List<ai.opencode.desk.model.Notification>) {
        val origin = DeskPointers.normalize(gateway.origin)
        val result = Reconciler.reconcile(
            origin,
            records.map { Reconciler.Record(it.editspace, it.id, it.revision, it.title, it.status, it.content_revision, it.delivery_state, it.answer?.answered_at) },
            requests.map { Reconciler.Request(it.kind, it.editspace, it.id, it.session, it.title) },
            ledger, System.currentTimeMillis(),
        )
        ledger = result.ledger
        prefs.edit().putString("notify.ledger", ai.opencode.desk.net.json.encodeToString(MapSerializer(String.serializer(), Int.serializer()), ledger)).apply()
        notifier.apply(result.actions)
    }

    // A notification tap. Refused when the tag's origin is not this instance's pairing
    // (the other profile owns it); otherwise the record is shown once loaded, and a moved
    // revision or a status that left open shows the current state rather than a stale prompt.
    fun openDeepLink(target: Reconciler.Target, revision: Int): Boolean {
        if (target.origin != DeskPointers.normalize(gateway.origin)) return false
        deepLink = target; deepLinkRevision = revision
        nudges.tryEmit(Unit)
        return true
    }

    private fun deriveAgents(): List<Agent> = states.flatMap { (es, state) ->
        val fromLanes = state.threads.flatMap { thread ->
            thread.lanes.map { lane ->
                // Only sessions anchored in the lane directory count; a parent session that
                // holds the lane record while the worker starts is never shown as the lane.
                val sessions = thread.sessions.filter { Anchors.inLane(lane, it) }.sortedByDescending { it.updated }
                val head = Anchors.pick(lane, thread.sessions)
                Agent(
                    key = "$es/${lane.lane}",
                    editspace = es,
                    lane = lane.lane,
                    title = thread.title.ifBlank { lane.lane },
                    description = thread.description,
                    status = Anchors.status(lane, head, sessions),
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
        }.onFailure { nudges.tryEmit(Unit) }

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
            outbox[session.id] = Outbox.reconcile(outbox[session.id].orEmpty(), detail.receipts, detail.messages.map { it.info.id }.toSet())
            remember(session.id, outbox[session.id].orEmpty())
            release(outbox[session.id].orEmpty())
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

    // Local echo first, then the durable POST. The requestID is fixed at tap time so a retry
    // after a timeout cannot double-admit: Core returns the original receipt for the same ID.
    private suspend fun send(sessionID: String, directory: String, text: String, delivery: String, requestID: String = UUID.randomUUID().toString(), after: () -> Unit = {}): Pending {
        val origin = gateway.origin
        // The durable entry is written before the first attempt and reused verbatim by retries.
        val entry = durable.get(origin, requestID) ?: OutboxEntry(
            requestID, origin, sessionID, directory, text, delivery,
            images = drafts[sessionID]?.takeIf { it.requestID == requestID }?.images.orEmpty(), createdAt = System.currentTimeMillis(),
        ).also { durable.put(it); drafts.remove(sessionID) }
        val existing = outbox[sessionID].orEmpty().firstOrNull { it.requestID == requestID }
        val item = existing?.copy(state = SendState.Sending, error = null, attempts = existing.attempts + 1)
            ?: Pending(requestID, sessionID, entry.text, entry.delivery, SendState.Sending, createdAt = entry.createdAt, images = entry.images.size)
        outbox[sessionID] = outbox[sessionID].orEmpty().filter { it.requestID != requestID } + item
        val result = runCatching {
            val images = withContext(Dispatchers.IO) { durable.payload(entry) }
            api.input(sessionID, entry.directory, entry.text, entry.delivery, requestID = requestID, images = images)
        }
        val settled = result.fold(
            onSuccess = { item.copy(state = Outbox.fromReceipt(it), messageID = it.messageID) },
            onFailure = { error ->
                when {
                    error is GatewayError && error.code in 400..499 -> item.copy(state = SendState.Failed, error = AttentionInput.ledgerError(error.body, error.message ?: "rejected"))
                    // Timeouts, resets and 5xx: the server may or may not have admitted it. Same ID retries safely.
                    else -> item.copy(state = SendState.Uncertain, error = error.message)
                }
            },
        )
        outbox[sessionID] = outbox[sessionID].orEmpty().map { if (it.requestID == requestID) settled else it }
        remember(sessionID, listOf(settled))
        after()
        return settled
    }

    suspend fun steer(agent: Agent, text: String, delivery: String): Result<Pending> {
        val session = agent.session ?: return Result.failure(IllegalStateException("This lane has no session yet"))
        return Result.success(send(session.id, session.directory, text, delivery, requestID(session.id)) { load(agent) })
    }

    suspend fun retry(item: Pending): Pending {
        // Retry only what was composed for this gateway; an entry from another host is never replayed here.
        val entry = durable.get(gateway.origin, item.requestID)
        val directory = entry?.directory ?: agents.firstOrNull { it.session?.id == item.sessionID }?.session?.directory ?: desk?.takeIf { it.id == item.sessionID }?.directory
            ?: return item.copy(state = SendState.Failed, error = "session not found")
        return send(item.sessionID, directory, item.text, item.delivery, item.requestID) {
            agents.firstOrNull { it.session?.id == item.sessionID }?.let(::load) ?: loadDesk()
        }
    }

    fun dismiss(item: Pending) {
        outbox[item.sessionID] = outbox[item.sessionID].orEmpty().filter { it.requestID != item.requestID }
        durable.remove(gateway.origin, item.requestID)
    }

    // Stored bytes are released as soon as the server has handled the input.
    private fun release(items: List<Pending>) {
        items.filter { it.done || (it.author == null && it.state == SendState.Presented) }.forEach { durable.remove(gateway.origin, it.requestID) }
    }

    // ---- image drafts ----
    // Normalises off the main thread once at pick time and stores the bytes under the send's
    // reserved requestID, so the later POST (and any retry) reads identical bytes.
    suspend fun attach(sessionID: String, uris: List<android.net.Uri>): String? {
        val draft = drafts[sessionID] ?: ImageDraft(UUID.randomUUID().toString(), emptyList())
        if (draft.images.size + uris.size > ImagePolicy.MAX_COUNT) return "At most ${ImagePolicy.MAX_COUNT} images are supported"
        val added = mutableListOf<StoredImage>()
        for ((offset, uri) in uris.withIndex()) {
            val normalized = withContext(Dispatchers.Default) { ImageIO.normalize(getApplication(), uri) }.getOrElse { return it.message ?: "Could not read image" }
            val index = draft.images.size + offset
            val path = withContext(Dispatchers.IO) { durable.store(draft.requestID, index, normalized.mime, normalized.bytes) }
            added += StoredImage(path, normalized.mime, normalized.bytes.size.toLong(), normalized.width, normalized.height)
        }
        val next = draft.copy(images = draft.images + added)
        ImagePolicy.issue(next.images)?.let { issue -> added.forEach { blobs.delete(it.path) }; return issue }
        drafts[sessionID] = next
        return null
    }

    fun detach(sessionID: String, image: StoredImage) {
        val draft = drafts[sessionID] ?: return
        blobs.delete(image.path)
        val next = draft.copy(images = draft.images - image)
        if (next.images.isEmpty()) { drafts.remove(sessionID); blobs.deleteAll("outbox/${draft.requestID}/") } else drafts[sessionID] = next
    }

    fun requestID(sessionID: String) = drafts[sessionID]?.requestID ?: UUID.randomUUID().toString()
    // Dimensions learned from the first decode of a transcript image on this device, by part id,
    // so a later mount reserves the exact box (CHAT-PARTS §3 interim).
    val imageDims = mutableStateMapOf<String, Pair<Int, Int>>()
    fun storedImages(requestID: String): List<StoredImage> = durable.get(gateway.origin, requestID)?.images.orEmpty()
    // Stored images for a transcript message this phone sent (by its message id), while the outbox record exists.
    fun storedImagesForMessage(sessionID: String, messageID: String): List<StoredImage> =
        outbox[sessionID].orEmpty().firstOrNull { it.messageID == messageID }?.let { storedImages(it.requestID) }.orEmpty()

    // ---- pins ----
    fun togglePin(pin: Pin) { pins = pinStore.toggle(gateway.origin, pin) }
    fun pinned(pin: Pin) = pins.any { it.key == pin.key }
    val pinViews: List<PinView> get() = Pins.resolve(pins, agents, states.mapValues { it.value.sessions })

    suspend fun stop(agent: Agent): Result<Boolean> {
        val session = agent.session ?: return Result.failure(IllegalStateException("No session"))
        return runCatching { api.abort(session.id, session.directory) }.onSuccess { nudges.tryEmit(Unit) }
    }

    suspend fun cancel(agent: Agent, requestID: String): Result<Unit> {
        val session = agent.session ?: return Result.failure(IllegalStateException("No session"))
        return runCatching { api.cancelInput(session.id, session.directory, requestID) }.onSuccess { durable.remove(gateway.origin, requestID); load(agent) }
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
            runCatching { api.receipts(pointer.id, pointer.directory).items }.onSuccess { receipts ->
                deskReceipts[pointer.id] = receipts.filter { r -> r.state == "pending" || r.state == "promoted" }
                outbox[pointer.id] = Outbox.reconcile(outbox[pointer.id].orEmpty(), receipts, deskMessages[pointer.id].orEmpty().map { it.info.id }.toSet())
                remember(pointer.id, outbox[pointer.id].orEmpty())
                release(outbox[pointer.id].orEmpty())
            }
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

    suspend fun askDesk(text: String): Result<Pending> =
        ensureDesk().map { pointer -> send(pointer.id, pointer.directory, text, "queue", requestID(pointer.id)) { loadDesk() } }
}

fun parseIso(value: String): Long? = runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
