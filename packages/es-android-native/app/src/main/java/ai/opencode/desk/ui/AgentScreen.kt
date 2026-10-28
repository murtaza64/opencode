package ai.opencode.desk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Agent
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Author
import ai.opencode.desk.Authorship
import ai.opencode.desk.Hosts
import ai.opencode.desk.Nav
import ai.opencode.desk.Outbox
import ai.opencode.desk.Pending
import ai.opencode.desk.Pin
import ai.opencode.desk.SendState
import ai.opencode.desk.Timeline
import ai.opencode.desk.Timestamps
import ai.opencode.desk.WakeRules
import androidx.compose.foundation.combinedClickable
import ai.opencode.desk.ToolGroup
import ai.opencode.desk.ToolRow
import ai.opencode.desk.ToolRows
import ai.opencode.desk.model.InputReceipt
import ai.opencode.desk.model.MessageWithParts
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun AgentScreen(store: DeskStore, nav: Nav, key: String) {
    val agent = store.agents.firstOrNull { it.key == key }
    if (agent == null) {
        Column(Modifier.fillMaxSize().statusBarsPadding().padding(20.dp)) {
            TopBar("Agent", onBack = { nav.pop() })
            Text("This lane is no longer listed.", style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    val detail = store.details[key]
    val scope = rememberCoroutineScope()
    // reverseLayout: index 0 sits at the bottom, so the screen opens at the newest message and
    // older pages append at the far end without moving what the reader is looking at.
    val list = rememberLazyListState()
    val previousTimeline = remember(key) { mutableStateOf<List<Timeline.Item>?>(null) }
    var diagnostics by rememberSaveable(key) { mutableStateOf(false) }
    // First frame after a transcript load: measured from loadedAt to the next drawn frame.
    LaunchedEffect(detail?.loadedAt) {
        val at = detail?.loadedAt ?: return@LaunchedEffect
        if (detail.messages.isEmpty()) return@LaunchedEffect
        withFrameNanos { }
        store.gateway.diagnostics.annotate("/session/${agent.session?.id}/message", renderMs = System.currentTimeMillis() - at)
    }
    val expandedIds = remember(key) { mutableStateMapOf<String, Boolean>() }
    // Finalize grouping once, on a real busy→idle/error transition of this session's status.
    val lastStatus = remember(key) { mutableStateOf(agent.status) }
    val frozen = remember(key) { mutableStateOf(agent.busy) }
    LaunchedEffect(agent.status) {
        if (Timeline.finalizes(lastStatus.value, agent.status)) frozen.value = false
        else if (agent.status == "busy") frozen.value = true
        lastStatus.value = agent.status
    }
    LaunchedEffect(key) { store.load(agent) }
    // Busy lanes change quickly; refresh the tail while this screen is open.
    LaunchedEffect(key, agent.busy) { while (agent.busy) { delay(8_000); store.load(agent) } }
    // Reaching the top (last reversed item) loads the page before the oldest loaded message.
    val atTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.key == "older" } }
    LaunchedEffect(atTop, detail?.cursor) { if (atTop) store.loadOlder(agent) }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        val pin = agent.pin
        val glyph = Hosts.forLane(agent.owner, store.host)
        TopBar(agent.title, onBack = { nav.pop() }, trailing = { PinButton(store.pinned(pin)) { store.togglePin(pin) } }, glyph = glyph, onLongPress = { diagnostics = true }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(agent.status, 7, animate = true)
                Label(listOfNotNull(Hosts.resolve(store.host)?.takeIf { glyph != null }?.let { "on ${it.label}" }, agent.editspace, agent.lane.takeIf { it.isNotBlank() }, agent.status, agent.session?.cost?.takeIf { it > 0 }?.let { "$%.2f".format(it) }).joinToString(" · "))
            }
        }
        CompositionLocalProvider(LocalExpanded provides expandedIds) {
        LazyColumn(Modifier.weight(1f).testTag("agent"), state = list, reverseLayout = true, contentPadding = PaddingValues(bottom = 8.dp, top = 8.dp)) {
            // Bottom of the screen first: pending inputs, then messages newest to oldest.
            val transcript = detail?.messages.orEmpty().map { it.info.id }.toSet()
            val pending = Timeline.dedupPending(Outbox.visible(store.outbox[agent.session?.id.orEmpty()].orEmpty(), transcript), detail?.messages.orEmpty())
            items(pending.asReversed(), key = { it.requestID }) { item ->
                PendingBubble(item, store,
                    onRetry = { scope.launch { store.retry(item) } },
                    onCancel = { scope.launch { if (item.state == SendState.Accepted) store.cancel(agent, item.requestID); store.dismiss(item) } })
            }
            detail?.error?.let { item(key = "error") { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) } }
            if (detail == null) item(key = "loading") { Text("Loading…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) }
            // Grouping is frozen while this agent's run is live so chips and strips do not reshuffle under the reader.
            val placed = Authorship.place(detail?.messages.orEmpty(), store.mine[agent.session?.id.orEmpty()].orEmpty())
            val built = Timeline.buildFrozen(previousTimeline.value, placed, frozen.value).also { previousTimeline.value = it }
            val timeline = Timeline.withMarkers(built, detail?.wakeEvents.orEmpty())
            val mail = detail?.mail.orEmpty()
            val sessionID = agent.session?.id
            items(timeline.asReversed(), key = { it.key() }) { TimelineItem(it, store.now, store, evidence = { chip -> WakeRules.forMail(mail, chip.key, sessionID) }, agent = agent.lane) }
            item(key = "older") {
                val more = detail?.cursor != null
                Text(
                    when { detail?.loadingOlder == true -> "Loading earlier…"; more -> "Scroll for earlier" ; detail != null && detail.messages.isNotEmpty() -> "Start of conversation"; else -> "" },
                    style = MaterialTheme.typography.labelSmall, modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), textAlign = TextAlign.Center,
                )
            }
            item(key = "conversation-header") { SectionHeader("Conversation", detail?.let { "updated " + age(store.now, it.loadedAt) }) }
            val todos = detail?.todos.orEmpty().filter { it.status != "completed" && it.status != "cancelled" }
            if (todos.isNotEmpty()) {
                items(todos.take(5).asReversed(), key = { "todo-" + it.content.hashCode() }) { todo ->
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(if (todo.status == "in_progress") Ink.Green else Ink.Dim, CircleShape))
                        Spacer(Modifier.width(12.dp))
                        Text(todo.content, style = MaterialTheme.typography.bodyMedium, color = if (todo.status == "in_progress") Ink.Text else Ink.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                item(key = "plan-header") { SectionHeader("Plan", "${detail?.todos?.count { it.status == "completed" }}/${detail?.todos?.size} done") }
            }
            detail?.work?.turn?.let { turn ->
                item(key = "turn") {
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 10.dp).fillMaxWidth().background(Ink.Panel, RoundedCornerShape(2.dp)).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column { Text("${turn.elapsed_seconds / 60}m", style = MaterialTheme.typography.titleMedium); Label("this turn") }
                        Column { Text("${turn.tool_calls}", style = MaterialTheme.typography.titleMedium); Label("tool calls") }
                        if (turn.active_tools.isNotEmpty()) Column(Modifier.weight(1f)) { Text(turn.active_tools.joinToString(), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis); Label("running") }
                    }
                }
            }
            if (agent.description.isNotBlank()) item(key = "description") { Text(agent.description, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp), maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
        }
        SteerBar(store, agent)
    }
    if (diagnostics) DiagnosticsSheet(store) { diagnostics = false }
}

// Long-press on the agent header: the last 20 requests with stage timings, parse/frame ms for
// the message page, and whether it used the compact shape. Read-only.
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsSheet(store: DeskStore, onDismiss: () -> Unit) {
    val rows = store.gateway.diagnostics.snapshot().asReversed()
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Ink.Panel) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).testTag("diagnostics")) {
            Text("Diagnostics", style = MaterialTheme.typography.titleMedium)
            Label("last ${rows.size} requests · ${store.gateway.origin}")
            Spacer(Modifier.height(8.dp))
            if (rows.isEmpty()) Text("No requests yet.", style = MaterialTheme.typography.bodyMedium)
            rows.forEach { t -> Mono(ai.opencode.desk.Diagnostics.line(t), color = if (t.error != null) Ink.Red else Ink.Muted, modifier = Modifier.padding(vertical = 3.dp), lines = 2) }
        }
    }
}

@Composable
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
fun TopBar(title: String, onBack: () -> Unit, trailing: (@Composable () -> Unit)? = null, glyph: Hosts.Glyph? = null, onLongPress: (() -> Unit)? = null, subtitle: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(end = 8.dp, top = 4.dp, bottom = 6.dp).then(if (onLongPress != null) Modifier.combinedClickable(onClick = {}, onLongClick = onLongPress) else Modifier), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Ink.Text) }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (glyph != null) { HostGlyph(glyph, color = Ink.Text, size = 14); Spacer(Modifier.width(6.dp)) }
                Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            subtitle?.invoke()
        }
        trailing?.invoke()
    }
}

@Composable
fun PinButton(pinned: Boolean, onToggle: () -> Unit) {
    IconButton(onClick = onToggle, modifier = Modifier.testTag("pin")) {
        Icon(if (pinned) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder, if (pinned) "Unpin from home" else "Pin to home", tint = if (pinned) Ink.Amber else Ink.Muted)
    }
}

// One send from this phone as an outgoing bubble: text and inline previews from the stored
// record (same composable and box as the accepted message), then the proven state. Failed and
// unconfirmed sends can be retried with the same request ID; accepted ones can be cancelled.
@Composable
fun PendingBubble(item: Pending, store: DeskStore, onRetry: () -> Unit, onCancel: () -> Unit) {
    val tint = when (item.state) { SendState.Failed -> Ink.Red; SendState.Uncertain -> Ink.Amber; SendState.Presented, SendState.Handled -> Ink.Green; else -> Ink.Amber }
    val stored = store.storedImages(item.requestID)
    val status = Timeline.pendingStatus(item.state)
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp).testTag("pending-" + item.state.name.lowercase()).semantics { contentDescription = "Sent from this phone: ${item.text.take(60)}, ${status ?: item.label}" }, horizontalAlignment = Alignment.End) {
        item.author?.let { AuthorHeader(it, Ink.Violet) }
        val sending = item.state == SendState.Sending || item.state == SendState.Uncertain
        Column(
            Modifier.widthIn(max = 320.dp).background(Ink.Blue.copy(alpha = if (sending) 0.08f else 0.22f), RoundedCornerShape(2.dp))
                .padding(horizontal = if (item.text.isNotBlank()) 14.dp else 4.dp, vertical = if (item.text.isNotBlank()) 10.dp else 4.dp),
        ) {
            if (item.text.isNotBlank()) Text(item.text, style = MaterialTheme.typography.bodyLarge, color = Ink.Text, maxLines = 6, overflow = TextOverflow.Ellipsis)
            if (stored.isNotEmpty()) InlinePreviews(stored.map { Preview.Stored(it) }, store, Modifier.padding(top = if (item.text.isNotBlank()) 6.dp else 0.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (item.state == SendState.Sending) StatusDot("busy", 5)
            Label(status ?: item.label.substringAfter("· ", item.label), color = tint, modifier = Modifier.padding(start = if (item.state == SendState.Sending) 4.dp else 0.dp))
            if (item.retryable) {
                Label("retry", color = Ink.Blue, modifier = Modifier.padding(start = 10.dp).clickable(onClick = onRetry))
                Label("discard", color = Ink.Muted, modifier = Modifier.padding(start = 10.dp).clickable(onClick = onCancel))
            } else if (item.state == SendState.Accepted) Label("cancel", color = Ink.Muted, modifier = Modifier.padding(start = 10.dp).clickable(onClick = onCancel))
        }
    }
}

// Transcript rows. Assistant prose is plain. User-role input is labelled by what the phone can
// prove about its author (Authorship): only this phone's own sends sit in the blue bubble;
// mail, system and unattributed input are left-aligned cards with an icon + text header
// (never colour alone). `first` is false when the previous message shares the author exactly,
// in which case the header is omitted and the card continues the run.
@Composable
fun Message(message: MessageWithParts, now: Long, author: Author? = null, first: Boolean = true, store: DeskStore? = null) {
    val text = message.parts.filter { it.type == "text" && !it.text.isNullOrBlank() }.joinToString("\n\n") { it.text!!.trim() }
    val tools = message.parts.filter { it.type == "tool" }
    if (author != null && author != Author.You && author !is Author.Operator) { SourcedMessage(author, text, message.info.id, now, message.info.time.created, first, if (store != null) previews(message.parts) else emptyList(), store); return }
    val you = author == Author.You || author is Author.Operator
    val stored = if (you && store != null) store.storedImagesForMessage(message.info.sessionID, message.info.id) else emptyList()
    val images = if (store != null) previews(message.parts, stored) else emptyList()
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = if (first) 6.dp else 2.dp, bottom = 6.dp), horizontalAlignment = if (you) Alignment.End else Alignment.Start) {
        if (you && first) AuthorHeader(author!!, Ink.Blue)
        if (you) {
            var expanded by rememberSaveable(message.info.id) { mutableStateOf(false) }
            Column(
                Modifier.widthIn(max = 320.dp).background(Ink.Blue.copy(alpha = 0.22f), RoundedCornerShape(2.dp)).clickable { expanded = !expanded }
                    .padding(horizontal = if (text.isNotBlank()) 14.dp else 4.dp, vertical = if (text.isNotBlank()) 10.dp else 4.dp),
            ) {
                if (text.isNotBlank()) Text(AnnotatedString(text), style = MaterialTheme.typography.bodyLarge, maxLines = if (expanded) Int.MAX_VALUE else 10, overflow = TextOverflow.Ellipsis)
                if (images.isNotEmpty()) InlinePreviews(images, store!!, Modifier.padding(top = if (text.isNotBlank()) 6.dp else 0.dp))
            }
        } else {
            if (text.isNotBlank()) {
                var expanded by rememberSaveable(message.info.id) { mutableStateOf(false) }
                Box(Modifier.clickable { expanded = !expanded }) { Text(markdownish(text), style = MaterialTheme.typography.bodyLarge, maxLines = if (expanded) Int.MAX_VALUE else 10, overflow = TextOverflow.Ellipsis) }
            }
            if (images.isNotEmpty()) InlinePreviews(images, store!!, Modifier.padding(top = 6.dp))
        }
        ToolRows.groups(message.parts).forEach { group -> ToolGroupView(group, message.info.id) }
        TimeLabel(message.info.time.created, message.info.time.completed, now)
    }
}

// Quiet relative age; long-press shows the recorded time (never the render clock) and the
// block's duration when known (CHAT-PARTS §5, Android).
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun TimeLabel(created: Long, completed: Long?, now: Long) {
    var details by rememberSaveable("ts-$created") { mutableStateOf(false) }
    val text = if (details) Timestamps.details(created, completed) else age(now, created)
    Label(text, color = Ink.Dim, modifier = Modifier.padding(top = 2.dp).combinedClickable(onClick = { if (details) details = false }, onLongClick = { details = true }).semantics { contentDescription = Timestamps.details(created, completed) })
}

@Composable
fun AuthorHeader(author: Author, tint: Color, modifier: Modifier = Modifier) {
    val icon = when (author) {
        Author.You, is Author.Operator -> Icons.Filled.Person
        is Author.Agent -> Icons.Filled.Email
        is Author.System -> Icons.Filled.Settings
        is Author.Unattributed, is Author.Integration -> Icons.Filled.Info
    }
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = author.description }, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(5.dp))
        Label(author.label, color = tint)
    }
}

// Input the human did not type on this phone: a left-aligned card whose header says who did.
// Quoted approvals inside the text stay inside the text; they never change the header.
@Composable
fun SourcedMessage(author: Author, text: String, messageID: String, now: Long, created: Long, first: Boolean, images: List<Preview> = emptyList(), store: DeskStore? = null) {
    var expanded by rememberSaveable("srcx-$messageID") { mutableStateOf(false) }
    val tint = when (author) { is Author.Agent -> Ink.Violet; is Author.System -> Ink.Muted; else -> Ink.Amber }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = if (first) 6.dp else 2.dp, bottom = 6.dp)) {
        Column(Modifier.weight(1f).background(tint.copy(alpha = 0.10f), RoundedCornerShape(2.dp)).padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (first) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                AuthorHeader(author, tint, Modifier.weight(1f))
                Label(age(now, created), color = Ink.Dim)
            }
            if (text.isNotBlank()) Text(
                markdownish(text), style = MaterialTheme.typography.bodyMedium, color = Ink.Text,
                maxLines = if (expanded) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = if (first) 6.dp else 0.dp).clickable { expanded = !expanded },
            )
            if (images.isNotEmpty() && store != null) InlinePreviews(images, store, Modifier.padding(top = if (text.isNotBlank()) 6.dp else 0.dp))
            if (!first) TimeLabel(created, null, now)
        }
    }
}

// Steer goes in at the next safe boundary while the agent works; Queue waits until it would
// otherwise go idle. Stop interrupts the current turn.
@Composable
private fun SteerBar(store: DeskStore, agent: Agent) {
    val sessionID = agent.session?.id.orEmpty()
    // Durable draft: text lives in the store per (origin, session) and survives kill/rotation/navigation.
    val text = store.draftText(sessionID)
    val setText = { value: String -> store.setDraftText(sessionID, value) }
    var queue by rememberSaveable(agent.key) { mutableStateOf(!agent.busy) }
    var busy by rememberSaveable(agent.key) { mutableStateOf(false) }
    var error by rememberSaveable(agent.key) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().background(Ink.Black).imePadding().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        error?.let { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 8.dp)) }
        if (sessionID.isNotEmpty()) DraftStrip(store, sessionID)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Toggle(if (queue) "queue" else "steer", if (queue) Ink.Violet else Ink.Green) { queue = !queue }
            Spacer(Modifier.width(8.dp))
            if (agent.busy) { Toggle("stop", Ink.Red, modifier = Modifier.testTag("stop")) { scope.launch { store.stop(agent).onFailure { error = it.message } } }; Spacer(Modifier.width(8.dp)) }
            Spacer(Modifier.weight(1f))
            Label(if (queue) "runs when idle" else "next safe boundary")
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (sessionID.isNotEmpty()) AttachButton(store, sessionID) { error = it }
            TextField(
                value = text, onValueChange = setText, maxLines = 4,
                placeholder = { Text(if (agent.session == null) "No session yet" else "Tell ${agent.lane.ifBlank { "this session" }}…", color = Ink.Dim) },
                modifier = Modifier.weight(1f).testTag("steer-text"), shape = RoundedCornerShape(4.dp),
                colors = TextFieldDefaults.colors(focusedContainerColor = Ink.Panel, unfocusedContainerColor = Ink.Panel, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Ink.Blue),
            )
            val hasImages = store.drafts[sessionID]?.images?.isNotEmpty() == true
            IconButton(enabled = (text.isNotBlank() || hasImages) && !busy && agent.session != null, modifier = Modifier.testTag("steer-send"), onClick = {
                val message = text.trim(); busy = true; error = null
                scope.launch {
                    store.steer(agent, message, if (queue) "queue" else "steer").fold({ /* draft cleared by the store once accepted */ }, { error = it.message?.take(120) })
                    busy = false
                }
            }) { Icon(Icons.Filled.Send, "Send", tint = if (text.isNotBlank() || hasImages) Ink.Blue else Ink.Dim) }
        }
    }
}

@Composable
private fun Toggle(text: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier.background(color.copy(alpha = 0.16f), RoundedCornerShape(2.dp)).clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp)) { Label(text, color = color) }
}

// A run of the same tool. One or two calls show as rows; three or more fold into a summary
// line ("bash ×7 · last command", failures counted) that opens into the individual rows.
@Composable
fun ToolGroupView(group: ToolGroup, messageID: String) {
    if (group.rows.size <= 2) { group.rows.forEachIndexed { index, row -> ToolRowView(row, "$messageID-${group.tool}-$index") }; return }
    var open by rememberSaveable("$messageID-${group.tool}-group") { mutableStateOf(group.live || group.failures > 0) }
    val tint = when { group.failures > 0 -> Ink.Red; group.live -> Ink.Green; else -> Ink.Muted }
    Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(6.dp).background(tint, CircleShape))
        Spacer(Modifier.width(10.dp))
        Mono("${group.tool} ×${group.rows.size}", color = tint)
        Spacer(Modifier.width(10.dp))
        Mono(group.rows.last().primary, color = Ink.Muted, modifier = Modifier.weight(1f))
        if (group.failures > 0) Label("${group.failures} failed", color = Ink.Red)
        Label(if (open) "hide" else "show", color = Ink.Dim, modifier = Modifier.padding(start = 8.dp))
    }
    if (open) Column(Modifier.padding(start = 16.dp)) { group.rows.forEachIndexed { index, row -> ToolRowView(row, "$messageID-${group.tool}-$index") } }
}

// One call: status dot, tool name, what it did, and the number that matters. Tap for output.
@Composable
fun ToolRowView(row: ToolRow, key: String) {
    var open by rememberSaveable(key) { mutableStateOf(false) }
    val tint = when { row.failed -> Ink.Red; row.live -> Ink.Green; else -> Ink.Muted }
    Column(Modifier.fillMaxWidth().clickable(enabled = !row.output.isNullOrBlank()) { open = !open }.padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (row.live) StatusDot("busy", 6) else Box(Modifier.size(6.dp).background(tint, CircleShape))
            Spacer(Modifier.width(10.dp))
            Mono(row.tool, color = tint, modifier = Modifier.width(56.dp))
            if (row.mono) Mono(row.primary, color = Ink.Text, modifier = Modifier.weight(1f))
            else Text(row.primary, style = MaterialTheme.typography.bodyMedium, color = Ink.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            row.secondary?.let { Label(it, color = if (row.failed) Ink.Red else Ink.Muted, modifier = Modifier.padding(start = 8.dp)) }
        }
        if (open && !row.output.isNullOrBlank()) {
            Text(
                row.output.take(1500) + if (row.output.length > 1500) "\n…" else "",
                style = MaterialTheme.typography.labelMedium, color = if (row.failed) Ink.Red else Ink.Muted,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp).background(Ink.Panel, RoundedCornerShape(2.dp)).padding(10.dp),
            )
        }
    }
}

