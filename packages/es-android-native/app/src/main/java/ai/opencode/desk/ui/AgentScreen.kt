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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Agent
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Nav
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
    val list = rememberLazyListState()
    LaunchedEffect(key) { store.load(agent) }
    // Open at the newest message; the plan and current turn sit above it to scroll back to.
    LaunchedEffect(detail?.loadedAt) {
        if (detail == null || detail.messages.isEmpty()) return@LaunchedEffect
        withFrameNanos {}
        list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
    }
    // Busy lanes change quickly; refresh the tail while this screen is open.
    LaunchedEffect(key, agent.busy) { while (agent.busy) { delay(8_000); store.load(agent) } }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        TopBar(agent.title, onBack = { nav.pop() }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(agent.status, 8)
                Label(listOfNotNull(agent.editspace, agent.lane, agent.status, agent.session?.cost?.takeIf { it > 0 }?.let { "$%.2f".format(it) }).joinToString(" · "))
            }
        }
        LazyColumn(Modifier.weight(1f).testTag("agent"), state = list, contentPadding = PaddingValues(bottom = 16.dp)) {
            if (agent.description.isNotBlank()) item { Text(agent.description, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp), maxLines = 3, overflow = TextOverflow.Ellipsis) }
            detail?.work?.turn?.let { turn ->
                item {
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 10.dp).fillMaxWidth().background(Ink.Panel, RoundedCornerShape(12.dp)).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column { Text("${turn.elapsed_seconds / 60}m", style = MaterialTheme.typography.titleMedium); Label("this turn") }
                        Column { Text("${turn.tool_calls}", style = MaterialTheme.typography.titleMedium); Label("tool calls") }
                        if (turn.active_tools.isNotEmpty()) Column(Modifier.weight(1f)) { Text(turn.active_tools.joinToString(), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis); Label("running") }
                    }
                }
            }
            val todos = detail?.todos.orEmpty().filter { it.status != "completed" && it.status != "cancelled" }
            if (todos.isNotEmpty()) {
                item { SectionHeader("Plan", "${detail?.todos?.count { it.status == "completed" }}/${detail?.todos?.size} done") }
                items(todos.take(5)) { todo ->
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(if (todo.status == "in_progress") Ink.Green else Ink.Dim, CircleShape))
                        Spacer(Modifier.width(12.dp))
                        Text(todo.content, style = MaterialTheme.typography.bodyMedium, color = if (todo.status == "in_progress") Ink.Text else Ink.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val pending = detail?.receipts.orEmpty().filter { it.state == "pending" || it.state == "promoted" }
            if (pending.isNotEmpty()) {
                item { SectionHeader("Waiting to deliver") }
                items(pending, key = { it.requestID }) { receipt -> ReceiptRow(receipt) { scope.launch { store.cancel(agent, receipt) } } }
            }
            item { SectionHeader("Conversation", detail?.let { "updated " + age(store.now, it.loadedAt) }) }
            if (detail == null) item { Text("Loading…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) }
            detail?.error?.let { item { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) } }
            items(detail?.messages.orEmpty().takeLast(12), key = { it.info.id }) { Message(it, store.now) }
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
        // Runs of the same tool fold into one line ("bash ×7") so a long turn stays skimmable.
        val runs = tools.fold(mutableListOf<MutableList<ai.opencode.desk.model.Part>>()) { acc, part ->
            if (acc.lastOrNull()?.first()?.tool == part.tool) acc.last().add(part) else acc.add(mutableListOf(part))
            acc
        }
        runs.forEach { run ->
            val last = run.last()
            var open by rememberSaveable(last.id) { mutableStateOf(false) }
            val state = last.state
            val tint = when {
                run.any { it.state?.status == "error" } -> Ink.Red
                state?.status == "running" || state?.status == "pending" -> Ink.Green
                else -> Ink.Muted
            }
            Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 3.dp)) {
                val count = if (run.size > 1) " ×${run.size}" else ""
                Mono("${last.tool}$count  ${state?.title ?: ""}".trim(), color = tint)
                if (open) run.forEach { part ->
                    val body = part.state?.error ?: part.state?.output ?: part.state?.input?.toString().orEmpty()
                    if (run.size > 1) Mono(part.state?.title ?: part.tool.orEmpty(), color = Ink.Text, modifier = Modifier.padding(start = 8.dp, top = 4.dp))
                    Text(body.take(800), style = MaterialTheme.typography.labelMedium, color = Ink.Muted, modifier = Modifier.padding(start = 8.dp, top = 2.dp))
                }
            }
        }
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
