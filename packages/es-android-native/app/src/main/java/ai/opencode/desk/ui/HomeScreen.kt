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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Link
import ai.opencode.desk.Pin
import ai.opencode.desk.PinView
import ai.opencode.desk.Profiles
import ai.opencode.desk.Surface
import ai.opencode.desk.Nav
import ai.opencode.desk.Route
import ai.opencode.desk.model.AttentionRecord
import kotlinx.coroutines.launch

private enum class Tab(val label: String) { Desk("Desk"), Needs("Needs you"), Agents("Agents") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(store: DeskStore, nav: Nav) {
    val tab = Tab.entries[nav.tab]
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshing by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val record = (store.open + store.snoozed + store.history).firstOrNull { it.id == selected }

    Scaffold(
        containerColor = Ink.Black,
        bottomBar = {
            Column {
                if (tab == Tab.Desk) Composer(store, nav)
                NavigationBar(containerColor = Ink.Panel, tonalElevation = 0.dp) {
                    Tab.entries.forEach { item ->
                        NavigationBarItem(
                            selected = tab == item,
                            onClick = { nav.tab = item.ordinal },
                            colors = NavigationBarItemDefaults.colors(indicatorColor = Ink.Raised, selectedIconColor = Ink.Text, selectedTextColor = Ink.Text, unselectedIconColor = Ink.Muted, unselectedTextColor = Ink.Muted),
                            label = { Text(item.label) },
                            modifier = Modifier.testTag("tab-${item.name.lowercase()}"),
                            icon = {
                                when (item) {
                                    Tab.Desk -> Icon(Icons.Filled.Home, null)
                                    Tab.Needs -> BadgedBox(badge = { if (store.filteredOpen.isNotEmpty()) Badge(containerColor = Ink.Amber, contentColor = Ink.Black) { Text("${store.filteredOpen.size}") } }) { Icon(Icons.Filled.Notifications, null) }
                                    Tab.Agents -> Icon(Icons.Filled.List, null)
                                }
                            },
                        )
                    }
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; store.refresh(); refreshing = false } },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when (tab) {
                Tab.Desk -> DeskTab(store, nav, onOpen = { selected = it.id }, onAll = { nav.tab = Tab.Needs.ordinal })
                Tab.Needs -> NeedsTab(store, onOpen = { selected = it.id })
                Tab.Agents -> AgentsTab(store, nav)
            }
        }
    }
    if (record != null) DecisionSheet(store, record, onDismiss = { selected = null })
}

// ---- Desk: the glance ----

@Composable
private fun DeskTab(store: DeskStore, nav: Nav, onOpen: (AttentionRecord) -> Unit, onAll: () -> Unit) {
    val open = store.filteredOpen
    val agents = store.filteredAgents
    val working = agents.filter { it.busy }
    val recent = store.history.filter { store.filter.isEmpty() || it.editspace in store.filter }.take(3)
    LazyColumn(Modifier.fillMaxSize().testTag("desk"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { Pulse(store, nav) }
        item { ProjectChips(store) }
        if (open.isNotEmpty()) {
            item { SectionHeader("Needs you", if (open.size > 3) "All ${open.size}" else null, onAll) }
            items(open.take(3), key = { it.id }) { AttentionRow(it, store.now, onClick = { onOpen(it) }) }
        } else item {
            SectionHeader("Needs you")
            Text("Nothing waiting on you.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp))
        }
        val pinned = store.pinViews.filter { store.filter.isEmpty() || it.pin.editspace in store.filter }
        if (pinned.isNotEmpty()) {
            item { SectionHeader("Pinned") }
            items(pinned, key = { "pin-" + it.pin.key }) { view -> PinRow(store, view, nav) }
        }
        val boards = store.surfaces.filter { store.filter.isEmpty() || it.editspace in store.filter }
        if (boards.isNotEmpty()) {
            item { SectionHeader("Boards & reports", "${boards.size}") }
            items(boards.take(6), key = { "surf-" + it.id }) { SurfaceRow(it, store.now) { nav.push(Route.Surface(it.id)) } }
        }
        if (working.isNotEmpty()) {
            item { SectionHeader("Working now", "${working.size}") }
            items(working, key = { it.key }) { AgentRow(it, store.now, onClick = { nav.push(Route.Agent(it.key)) }) }
        }
        val idle = agents.filter { !it.busy }.take(if (working.isEmpty()) 6 else 3)
        if (idle.isNotEmpty()) {
            item { SectionHeader(if (working.isEmpty()) "Agents" else "Recently active") }
            items(idle, key = { it.key }) { AgentRow(it, store.now, onClick = { nav.push(Route.Agent(it.key)) }) }
        }
        if (recent.isNotEmpty()) {
            item { SectionHeader("Decided") }
            items(recent, key = { "h-" + it.id }) { DecidedRow(it, store.now, onClick = { onOpen(it) }) }
        }
        if (store.link == Link.Connecting && store.updatedAt == 0L) item {
            Text("Loading…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp))
        }
    }
}

// The one-line truth about the fleet, plus a connection state that stays honest while offline.
@Composable
private fun Pulse(store: DeskStore, nav: Nav) {
    val agents = store.filteredAgents
    val open = store.filteredOpen
    val blocked = open.count { it.kind == "blocker" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Desk", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(12.dp))
            Label("conversation →", color = Ink.Blue, modifier = Modifier.clickable { nav.push(Route.Chat) }.padding(4.dp).testTag("open-chat"))
            Spacer(Modifier.width(8.dp))
            ProfileSwitchAction(store)
            Spacer(Modifier.weight(1f))
            val profile = Profiles.profileSuffix(store.profiles.current, store.profileSwitch.let { if (it.visible) listOf(Profiles.Target(it.label.orEmpty(), !store.profiles.current.managed)) else emptyList() })
            val (base, color) = when (store.link) {
                Link.Online -> "updated ${age(store.now, store.updatedAt)}" to Ink.Muted
                Link.Connecting -> "connecting" to Ink.Amber
                Link.Offline -> "offline · ${store.lastError?.take(40) ?: "retrying"}" to Ink.Red
                Link.Access -> "behind Cloudflare Access" to Ink.Red
                Link.Unpaired -> "unpaired" to Ink.Red
            }
            val text = if (profile != null) "$profile · $base" else base
            // The connection label doubles as the only settings surface: refresh or forget the pairing.
            var menu by rememberSaveable { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            Box {
                Label(text, color = color, modifier = Modifier.clickable { menu = true }.padding(4.dp).testTag("link"))
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Ink.Raised) {
                    DropdownMenuItem(text = { Text("Refresh now") }, onClick = { menu = false; scope.launch { store.refresh() } })
                    DropdownMenuItem(text = { Text(store.gateway.origin, style = MaterialTheme.typography.labelMedium) }, onClick = { menu = false }, enabled = false)
                    if (store.link == Link.Access) DropdownMenuItem(text = { Text("This server is behind Cloudflare Access. Forget the pairing to enter a service token.", style = MaterialTheme.typography.bodyMedium) }, onClick = { menu = false }, enabled = false)
                    DropdownMenuItem(text = { Text("Forget pairing", color = Ink.Red) }, onClick = { menu = false; store.unpair() }, modifier = Modifier.testTag("unpair"))
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            Stat("${agents.count { it.busy }}", "working", Ink.Green)
            Stat("${open.size}", "need you", if (open.isEmpty()) Ink.Dim else Ink.Amber)
            if (blocked > 0) Stat("$blocked", "blocked", Ink.Red)
            Stat("${store.projects.count { it.available }}/${store.projects.size.coerceAtLeast(store.editspaces.size)}", "projects", Ink.Muted)
        }
    }
}

@Composable
private fun Stat(value: String, label: String, color: Color) {
    Column {
        Text(value, style = MaterialTheme.typography.titleLarge, color = color)
        Label(label)
    }
}

@Composable
private fun ProjectChips(store: DeskStore) {
    if (store.editspaces.size < 2) { Spacer(Modifier.height(6.dp)); return }
    val unavailable = store.projects.filter { !it.available }.map { it.editspace }.toSet()
    LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        item { FilterChip("All", store.filter.isEmpty()) { store.filterProjects(emptySet()) } }
        items(store.editspaces) { name ->
            val count = store.open.count { it.editspace == name }
            FilterChip(if (count > 0) "$name · $count" else name, name in store.filter, dim = name in unavailable) {
                store.filterProjects(if (name in store.filter) store.filter - name else store.filter + name)
            }
        }
    }
}

@Composable
private fun FilterChip(text: String, selected: Boolean, dim: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier
            .background(if (selected) Ink.Text else Ink.Panel, RoundedCornerShape(2.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 7.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = when { selected -> Ink.Black; dim -> Ink.Dim; else -> Ink.Text })
    }
}

@Composable
private fun DecidedRow(record: AttentionRecord, now: Long, onClick: () -> Unit) {
    val choice = record.options.firstOrNull { it.id == (record.answer?.choice_id ?: record.decision) }?.label
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(10.dp).height(10.dp).background(deliveryColor(record.delivery_state), CircleShape))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(record.title, style = MaterialTheme.typography.bodyMedium, color = Ink.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Label(listOfNotNull(choice ?: record.answer?.text?.take(40), record.status, deliveryLabel(record.delivery_state)).joinToString(" · "))
        }
        Label(age(now, record.updated_at))
    }
}

// ---- Needs you: the whole queue ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NeedsTab(store: DeskStore, onOpen: (AttentionRecord) -> Unit) {
    var view by rememberSaveable { mutableStateOf(0) }
    val lists = listOf(store.filteredOpen, store.snoozed, store.history).map { list -> list.filter { store.filter.isEmpty() || it.editspace in store.filter } }
    LazyColumn(Modifier.fillMaxSize().testTag("needs"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Column(Modifier.padding(horizontal = 20.dp).padding(top = 12.dp)) {
                Text("Needs you", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(12.dp))
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    listOf("Open", "Snoozed", "History").forEachIndexed { index, label ->
                        SegmentedButton(
                            selected = view == index, onClick = { view = index },
                            shape = SegmentedButtonDefaults.itemShape(index, 3),
                            colors = SegmentedButtonDefaults.colors(activeContainerColor = Ink.Raised, activeContentColor = Ink.Text, inactiveContainerColor = Ink.Black, inactiveContentColor = Ink.Muted),
                        ) { Text("$label ${lists[index].size}", maxLines = 1) }
                    }
                }
                val stale = store.projects.filter { !it.available }
                if (stale.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Label("not reachable: ${stale.joinToString { it.editspace }}", color = Ink.Red)
                }
                Spacer(Modifier.height(8.dp))
            }
        }
        val list = lists[view]
        if (list.isEmpty()) item { Text(listOf("Nothing waiting on you.", "Nothing snoozed.", "No history yet.")[view], style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) }
        items(list, key = { it.id }) { record ->
            if (view == 2) DecidedRow(record, store.now, onClick = { onOpen(record) })
            else AttentionRow(record, store.now, onClick = { onOpen(record) })
        }
    }
}

// ---- Agents: everything running, grouped by project ----

@Composable
private fun AgentsTab(store: DeskStore, nav: Nav) {
    val groups = store.filteredAgents.groupBy { it.editspace }
    LazyColumn(Modifier.fillMaxSize().testTag("agents"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Column(Modifier.padding(horizontal = 20.dp).padding(top = 12.dp)) {
                Text("Agents", style = MaterialTheme.typography.titleLarge)
                Label("${store.filteredAgents.count { it.busy }} working · ${store.filteredAgents.size} lanes")
            }
        }
        groups.forEach { (es, agents) ->
            item(key = "h-$es") { SectionHeader(es, "${agents.count { it.busy }} live") }
            items(agents, key = { it.key }) { agent ->
                val pin = Pin(agent.editspace, agent.lane)
                AgentRow(agent, store.now, onClick = { nav.push(Route.Agent(agent.key)) }, trailing = { PinButton(store.pinned(pin)) { store.togglePin(pin) } })
            }
        }
        if (groups.isEmpty()) item { Text("No lanes yet.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp)) }
    }
}

// ---- Composer dock: talk to the desk from anywhere on Home ----

@Composable
private fun Composer(store: DeskStore, nav: Nav) {
    var text by rememberSaveable { mutableStateOf("") }
    var sending by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Row(
        Modifier.fillMaxWidth().background(Ink.Black).imePadding().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextField(
            value = text, onValueChange = { text = it },
            placeholder = { Text(if (store.deskBusy) "Desk is thinking… add to it" else "Ask the desk or start work", style = MaterialTheme.typography.bodyLarge, color = Ink.Dim) },
            modifier = Modifier.weight(1f).testTag("composer"),
            maxLines = 4,
            shape = RoundedCornerShape(4.dp),
            colors = TextFieldDefaults.colors(focusedContainerColor = Ink.Panel, unfocusedContainerColor = Ink.Panel, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Ink.Blue),
        )
        Spacer(Modifier.width(6.dp))
        IconButton(
            enabled = text.isNotBlank() && !sending,
            modifier = Modifier.testTag("send"),
            onClick = {
                val message = text.trim(); sending = true
                scope.launch {
                    store.askDesk(message).onSuccess { text = ""; nav.push(Route.Chat) }
                    sending = false
                }
            },
        ) { Icon(Icons.Filled.Send, "Send", tint = if (text.isNotBlank()) Ink.Blue else Ink.Dim) }
    }
}

fun deliveryColor(state: String) = when (state) {
    "handled", "presented" -> Ink.Green
    "blocked" -> Ink.Red
    "queued", "admitted", "pending" -> Ink.Amber
    else -> Ink.Dim
}

fun deliveryLabel(state: String) = when (state) {
    "not-requested" -> "recorded"
    "pending", "queued" -> "sending"
    "admitted" -> "delivered"
    "presented" -> "seen"
    "handled" -> "handled"
    "blocked" -> "undeliverable"
    "closed" -> "closed"
    else -> state
}

// A pinned lane as the human left it: live status from the last refresh, one tap to open.
// An unavailable pin stays (the lane may come back) and offers unpin instead of a screen.
@Composable
private fun PinRow(store: DeskStore, view: PinView, nav: Nav) {
    val unavailable = view.status == "unavailable"
    Row(
        Modifier.fillMaxWidth().clickable(enabled = !unavailable) { view.agentKey?.let { nav.push(Route.Agent(it)) } }.padding(start = 20.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(if (unavailable) "unknown" else view.status, 7)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(view.title, style = MaterialTheme.typography.bodyMedium, color = if (unavailable) Ink.Muted else Ink.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Label(listOfNotNull(view.pin.editspace, view.status, view.activity.takeIf { it.isNotBlank() }).joinToString(" · "), color = if (unavailable) Ink.Dim else Ink.Muted)
        }
        if (view.updatedAt > 0) Label(age(store.now, view.updatedAt), color = Ink.Dim)
        PinButton(true) { store.togglePin(view.pin) }
    }
}

// One published surface: title, owner · purpose, health as a dot, updated age. Unseen
// deliverables carry an amber "new" chip (read-only: opening does not mark them seen).
@Composable
private fun SurfaceRow(surface: Surface, now: Long, onClick: () -> Unit) {
    val health = when (surface.health.state) { "ok" -> "busy"; "error", "unreachable" -> "error"; else -> "idle" }
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp).testTag("surface-" + surface.id), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(health, 7)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(surface.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (surface.unseen) Chip("new", Ink.Amber, filled = true)
            }
            Label(listOfNotNull(surface.owner, surface.purpose, surface.health.detail ?: surface.health.state.takeIf { it != "ok" }).joinToString(" · "))
        }
        Label(age(now, surface.updated_at))
    }
}
