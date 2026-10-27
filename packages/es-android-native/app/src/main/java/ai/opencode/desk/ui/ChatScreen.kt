package ai.opencode.desk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Authorship
import ai.opencode.desk.Nav
import ai.opencode.desk.Outbox
import ai.opencode.desk.SendState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The Front Desk conversation: one thread per paired gateway, backed by a Core session with
// the `front-desk` agent. Reads like messaging; answers arrive as the session's assistant turns.
@Composable
fun ChatScreen(store: DeskStore, nav: Nav) {
    val id = store.deskID
    val messages = store.deskMessages[id].orEmpty()
    val pending = Outbox.visible(store.outbox[id].orEmpty(), messages.map { it.info.id }.toSet())
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    var text by rememberSaveable { mutableStateOf("") }
    var sending by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    // Poll while the screen is open: the reply arrives as a new assistant message and there is
    // no desk-specific event stream. Faster while the desk is busy or an input is pending.
    LaunchedEffect(Unit) {
        while (true) { store.loadDesk(); delay(if (store.deskBusy || store.outbox[store.deskID].orEmpty().any { !it.done }) 3_000 else 8_000) }
    }
    // Reversed list: newest at the bottom on open; older pages append at the top edge.
    val atTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.key == "older" } }
    LaunchedEffect(atTop, store.deskCursors[id]) { if (atTop) store.loadOlderDesk() }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        TopBar("Desk", onBack = { nav.pop() }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (store.deskBusy) "busy" else "idle", 8)
                Spacer(Modifier.width(8.dp))
                Label(if (store.deskBusy) "thinking" else if (store.deskReady) "front-desk · ${store.deskSpace}" else "new conversation")
            }
        }
        LazyColumn(Modifier.weight(1f).testTag("chat"), state = list, reverseLayout = true, contentPadding = PaddingValues(vertical = 8.dp)) {
            items(pending.asReversed(), key = { "r-" + it.requestID }) { item ->
                val tint = when (item.state) { SendState.Failed -> Ink.Red; SendState.Presented, SendState.Handled -> Ink.Green; else -> Ink.Amber }
                Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), horizontalAlignment = Alignment.End) {
                    Text(item.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.background(Ink.Blue.copy(alpha = if (item.state == SendState.Sending) 0.08f else 0.14f), RoundedCornerShape(16.dp)).padding(horizontal = 14.dp, vertical = 10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Label(item.label, color = tint)
                        if (item.retryable) {
                            Label("retry", color = Ink.Blue, modifier = Modifier.padding(start = 10.dp).clickable { scope.launch { store.retry(item) } })
                            Label("discard", color = Ink.Muted, modifier = Modifier.padding(start = 10.dp).clickable { store.dismiss(item) })
                        }
                    }
                }
            }
            val placed = Authorship.place(messages, store.mine[id].orEmpty())
            items(placed.asReversed(), key = { it.message.info.id }) { Message(it.message, store.now, it.author, it.first, store) }
            item(key = "older") {
                val more = store.deskCursors[id] != null
                if (messages.isEmpty() && pending.isEmpty()) Column(Modifier.padding(20.dp)) {
                    Text("Ask what's going on, or start work.", style = MaterialTheme.typography.bodyLarge)
                    Text("The desk knows the open decisions and every lane's recent activity. Try: “what changed since this morning?” or “start a lane to fix the flaky composer test”.", style = MaterialTheme.typography.bodyMedium)
                } else Text(if (more) "Scroll for earlier" else "Start of conversation", style = MaterialTheme.typography.labelSmall, modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), textAlign = TextAlign.Center)
            }
        }
        error?.let { Text(it, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp)) }
        if (store.deskReady) DraftStrip(store, id)
        val hasImages = store.drafts[id]?.images?.isNotEmpty() == true
        Row(Modifier.fillMaxWidth().background(Ink.Black).imePadding().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (store.deskReady) AttachButton(store, id) { error = it }
            TextField(
                value = text, onValueChange = { text = it }, maxLines = 5,
                placeholder = { Text("Message the desk", color = Ink.Dim) },
                modifier = Modifier.weight(1f).testTag("chat-text"), shape = RoundedCornerShape(22.dp),
                colors = TextFieldDefaults.colors(focusedContainerColor = Ink.Panel, unfocusedContainerColor = Ink.Panel, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Ink.Blue),
            )
            IconButton(enabled = (text.isNotBlank() || hasImages) && !sending, modifier = Modifier.testTag("chat-send"), onClick = {
                val message = text.trim(); sending = true; error = null
                scope.launch {
                    store.askDesk(message).fold({ text = "" }, { error = it.message?.take(120) })
                    sending = false
                }
            }) { Icon(Icons.Filled.Send, "Send", tint = if (text.isNotBlank() || hasImages) Ink.Blue else Ink.Dim) }
        }
    }
}
