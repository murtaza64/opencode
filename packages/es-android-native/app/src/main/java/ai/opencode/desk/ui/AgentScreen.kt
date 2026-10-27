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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Agent
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Nav
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
    LaunchedEffect(key) { store.load(agent) }
    // Busy lanes change quickly; refresh the tail while this screen is open.
    LaunchedEffect(key, agent.busy) { while (agent.busy) { delay(8_000); store.load(agent) } }
    // Reaching the top (last reversed item) loads the page before the oldest loaded message.
    val atTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.key == "older" } }
    LaunchedEffect(atTop, detail?.cursor) { if (atTop) store.loadOlder(agent) }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        TopBar(agent.title, onBack = { nav.pop() }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(agent.status, 8)
                Label(listOfNotNull(agent.editspace, agent.lane, agent.status, agent.session?.cost?.takeIf { it > 0 }?.let { "$%.2f".format(it) }).joinToString(" · "))
            }
        }
        LazyColumn(Modifier.weight(1f).testTag("agent"), state = list, reverseLayout = true, contentPadding = PaddingValues(bottom = 8.dp, top = 8.dp)) {
            // Bottom of the screen first: pending inputs, then messages newest to oldest.
            val pending = detail?.receipts.orEmpty().filter { it.state == "pending" || it.state == "promoted" }
            items(pending.asReversed(), key = { it.requestID }) { receipt -> ReceiptRow(receipt) { scope.launch { store.cancel(agent, receipt) } } }
            if (pending.isNotEmpty()) item(key = "pending-header") { SectionHeader("Waiting to deliver") }
            detail?.error?.let { item(key = "error") { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) } }
            if (detail == null) item(key = "loading") { Text("Loading…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) }
            items(detail?.messages.orEmpty().asReversed(), key = { it.info.id }) { Message(it, store.now) }
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
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 10.dp).fillMaxWidth().background(Ink.Panel, RoundedCornerShape(12.dp)).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column { Text("${turn.elapsed_seconds / 60}m", style = MaterialTheme.typography.titleMedium); Label("this turn") }
                        Column { Text("${turn.tool_calls}", style = MaterialTheme.typography.titleMedium); Label("tool calls") }
                        if (turn.active_tools.isNotEmpty()) Column(Modifier.weight(1f)) { Text(turn.active_tools.joinToString(), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis); Label("running") }
                    }
                }
            }
            if (agent.description.isNotBlank()) item(key = "description") { Text(agent.description, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp), maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
        SteerBar(store, agent)
    }
}

@Composable
fun TopBar(title: String, onBack: () -> Unit, subtitle: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(end = 16.dp, top = 4.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Ink.Text) }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.invoke()
        }
    }
}

@Composable
private fun ReceiptRow(receipt: InputReceipt, onCancel: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(receipt.text, style = MaterialTheme.typography.bodyMedium, color = Ink.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Label("${receipt.delivery} · ${receipt.state}", color = Ink.Amber)
        }
        if (receipt.state == "pending") TextButton(onClick = onCancel) { Text("Cancel", color = Ink.Muted) }
    }
}

// Transcript rows: user text right-aligned on the desk blue, assistant text plain,
// tools folded into one mono line each (name + title), expandable to the output.
@Composable
fun Message(message: MessageWithParts, now: Long) {
    val user = message.info.role == "user"
    val text = message.parts.filter { it.type == "text" && !it.text.isNullOrBlank() }.joinToString("\n\n") { it.text!!.trim() }
    val tools = message.parts.filter { it.type == "tool" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        if (text.isNotBlank()) {
            var expanded by rememberSaveable(message.info.id) { mutableStateOf(false) }
            Box(
                Modifier
                    .background(if (user) Ink.Blue.copy(alpha = 0.22f) else Color.Transparent, RoundedCornerShape(16.dp))
                    .clickable { expanded = !expanded }
                    .padding(horizontal = if (user) 14.dp else 0.dp, vertical = if (user) 10.dp else 0.dp),
            ) { Text(if (user) AnnotatedString(text) else markdownish(text), style = MaterialTheme.typography.bodyLarge, maxLines = if (expanded) Int.MAX_VALUE else 10, overflow = TextOverflow.Ellipsis) }
        }
        ToolRows.groups(message.parts).forEach { group -> ToolGroupView(group, message.info.id) }
        Label(age(now, message.info.time.created), color = Ink.Dim, modifier = Modifier.padding(top = 2.dp))
    }
}

// Steer goes in at the next safe boundary while the agent works; Queue waits until it would
// otherwise go idle. Stop interrupts the current turn.
@Composable
private fun SteerBar(store: DeskStore, agent: Agent) {
    var text by rememberSaveable(agent.key) { mutableStateOf("") }
    var queue by rememberSaveable(agent.key) { mutableStateOf(!agent.busy) }
    var busy by rememberSaveable(agent.key) { mutableStateOf(false) }
    var error by rememberSaveable(agent.key) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().background(Ink.Black).imePadding().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        error?.let { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 8.dp)) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Toggle(if (queue) "queue" else "steer", if (queue) Ink.Violet else Ink.Green) { queue = !queue }
            Spacer(Modifier.width(8.dp))
            if (agent.busy) { Toggle("stop", Ink.Red, modifier = Modifier.testTag("stop")) { scope.launch { store.stop(agent).onFailure { error = it.message } } }; Spacer(Modifier.width(8.dp)) }
            Spacer(Modifier.weight(1f))
            Label(if (queue) "runs when idle" else "next safe boundary")
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = text, onValueChange = { text = it }, maxLines = 4,
                placeholder = { Text("Tell ${agent.lane}…", color = Ink.Dim) },
                modifier = Modifier.weight(1f).testTag("steer-text"), shape = RoundedCornerShape(22.dp),
                colors = TextFieldDefaults.colors(focusedContainerColor = Ink.Panel, unfocusedContainerColor = Ink.Panel, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Ink.Blue),
            )
            IconButton(enabled = text.isNotBlank() && !busy && agent.session != null, modifier = Modifier.testTag("steer-send"), onClick = {
                val message = text.trim(); busy = true; error = null
                scope.launch {
                    store.steer(agent, message, if (queue) "queue" else "steer").fold({ text = "" }, { error = it.message?.take(120) })
                    busy = false
                }
            }) { Icon(Icons.Filled.Send, "Send", tint = if (text.isNotBlank()) Ink.Blue else Ink.Dim) }
        }
    }
}

@Composable
private fun Toggle(text: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier.background(color.copy(alpha = 0.16f), RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp)) { Label(text, color = color) }
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
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp).background(Ink.Panel, RoundedCornerShape(8.dp)).padding(10.dp),
            )
        }
    }
}
