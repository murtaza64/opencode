package ai.opencode.desk.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.DeskStore
import ai.opencode.desk.model.AttentionRecord
import kotlinx.coroutines.launch

// The decision surface: a sheet that slides up over the list (the list stays as context
// behind the scrim), expands to full height for long context, and dismisses with Back or
// a drag. Options are tall touch rows; the recommendation is marked, never pre-selected.
@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun DecisionSheet(store: DeskStore, record: AttentionRecord, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var choice by rememberSaveable(record.id) { mutableStateOf(record.answer?.choice_id ?: record.decision) }
    var note by rememberSaveable(record.id) { mutableStateOf("") }
    var writing by rememberSaveable(record.id) { mutableStateOf(record.options.isEmpty()) }
    var more by rememberSaveable(record.id) { mutableStateOf(false) }
    var error by rememberSaveable(record.id) { mutableStateOf<String?>(null) }
    var busy by rememberSaveable(record.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val closed = record.status != "open"
    val color = kindColor(record.kind)

    fun run(block: suspend () -> Result<AttentionRecord>, close: Boolean = true) {
        busy = true; error = null
        scope.launch {
            block().fold(
                onSuccess = { if (close) onDismiss() },
                onFailure = { error = it.message?.take(120) ?: "Failed" },
            )
            busy = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Ink.Panel, dragHandle = { Handle() }) {
        // The sheet is its own window, so it needs its own testTagsAsResourceId root.
        Column(Modifier.semantics { testTagsAsResourceId = true }.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).imePadding().navigationBarsPadding().testTag("decision")) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(record.kind, color)
                Label(listOfNotNull(record.editspace, record.lane).joinToString(" · "))
                Spacer(Modifier.weight(1f))
                Label(age(store.now, record.created_at) + " ago")
            }
            Spacer(Modifier.height(10.dp))
            Text(record.title, style = MaterialTheme.typography.titleLarge)
            if (record.context.isNotBlank()) {
                Spacer(Modifier.height(10.dp))
                Context(record.context)
            }

            if (closed) {
                Spacer(Modifier.height(16.dp))
                Outcome(record)
            } else {
                if (record.options.isNotEmpty()) {
                    Spacer(Modifier.height(18.dp))
                    record.options.forEach { option ->
                        val recommended = option.id == record.recommendation
                        val picked = option.id == choice
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .border(1.dp, if (picked) Ink.Text else Ink.Line, RoundedCornerShape(12.dp))
                                .background(if (picked) Ink.Raised else Color.Transparent, RoundedCornerShape(12.dp))
                                .clickable(enabled = !busy) { choice = option.id }
                                .padding(horizontal = 14.dp, vertical = 14.dp)
                                .testTag("option-${option.id}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(18.dp).border(2.dp, if (picked) Ink.Text else Ink.Dim, CircleShape).padding(4.dp).background(if (picked) Ink.Text else Color.Transparent, CircleShape))
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(option.label, style = MaterialTheme.typography.bodyLarge)
                                if (recommended) Label("recommended", color = Ink.Green)
                            }
                        }
                    }
                }

                AnimatedVisibility(writing) {
                    Column {
                        Spacer(Modifier.height(12.dp))
                        TextField(
                            value = note, onValueChange = { note = it },
                            placeholder = { Text(if (record.options.isEmpty()) "Your answer" else "Add a note (optional)", color = Ink.Dim) },
                            modifier = Modifier.fillMaxWidth().testTag("answer-text"), minLines = 2, maxLines = 6,
                            shape = RoundedCornerShape(12.dp),
                            colors = TextFieldDefaults.colors(focusedContainerColor = Ink.Raised, unfocusedContainerColor = Ink.Raised, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Ink.Blue),
                        )
                    }
                }

                if (error != null) { Spacer(Modifier.height(8.dp)); Text(error!!, color = Ink.Red, style = MaterialTheme.typography.bodyMedium) }
                Spacer(Modifier.height(16.dp))
                // Primary = send the answer to the agent. Secondary = record a choice without sending.
                val canSend = (choice != null || note.isNotBlank()) && !busy
                Button(
                    onClick = { run({ store.act(record) { r -> answer(r, note.ifBlank { record.options.first { it.id == choice }.label }, choice) } }) },
                    enabled = canSend, modifier = Modifier.fillMaxWidth().testTag("send-answer"),
                    colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Ink.Black),
                ) { Text(if (busy) "Sending…" else "Send to agent") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    if (!writing) TextButton(onClick = { writing = true }) { Text("Add a note", color = Ink.Muted) } else Spacer(Modifier.width(1.dp))
                    TextButton(onClick = { more = !more }) { Text(if (more) "Less" else "More", color = Ink.Muted) }
                }
                AnimatedVisibility(more) {
                    Column {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(enabled = choice != null && !busy, onClick = { run({ store.act(record) { r -> choose(r, choice!!) } }) }, modifier = Modifier.weight(1f)) { Text("Record only") }
                            OutlinedButton(enabled = !busy, onClick = { run({ store.act(record) { r -> snooze(r, System.currentTimeMillis() + 3_600_000) } }) }, modifier = Modifier.weight(1f)) { Text("Snooze 1h") }
                        }
                        TextButton(enabled = !busy, onClick = { run({ store.act(record) { r -> resolve(r, "Resolved from phone") } }) }) { Text("Resolve without answering", color = Ink.Red) }
                        Label("gate ${record.gate_key}", modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun Handle() {
    Box(Modifier.padding(top = 12.dp, bottom = 4.dp).width(36.dp).height(4.dp).background(Ink.Line, RoundedCornerShape(2.dp)))
}

// Long context collapses to five lines; a tap expands. Never a scroll-inside-scroll.
@Composable
private fun Context(text: String) {
    var expanded by rememberSaveable(text.hashCode()) { mutableStateOf(text.length < 320) }
    Column(Modifier.clickable { expanded = !expanded }) {
        Text(text.trim(), style = MaterialTheme.typography.bodyLarge, color = Ink.Muted, maxLines = if (expanded) Int.MAX_VALUE else 5, overflow = TextOverflow.Ellipsis)
        if (!expanded) Label("more", color = Ink.Blue, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun Outcome(record: AttentionRecord) {
    val choice = record.options.firstOrNull { it.id == (record.answer?.choice_id ?: record.decision) }?.label
    Column(Modifier.fillMaxWidth().background(Ink.Raised, RoundedCornerShape(12.dp)).padding(14.dp)) {
        Label(record.status, color = Ink.Text)
        if (choice != null) Text(choice, style = MaterialTheme.typography.bodyLarge)
        record.answer?.text?.takeIf { it.isNotBlank() && it != choice }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        record.resolution?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).background(deliveryColor(record.delivery_state), CircleShape))
            Label(deliveryLabel(record.delivery_state) + (record.delivery?.reason?.let { " · $it" } ?: ""))
        }
    }
}
