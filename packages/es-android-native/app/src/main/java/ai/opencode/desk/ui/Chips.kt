package ai.opencode.desk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Author
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Provenance
import ai.opencode.desk.Timeline
import ai.opencode.desk.detail

// Typed peer input as a one-line chip: icon, sender, kind, "→ recipient" when it was not
// addressed to this lane. No body until tapped; expansion is per message id and survives
// recomposition and paging via rememberSaveable (never persisted).
@Composable
fun MailChip(unit: Timeline.Unit.Chip, lane: String?, now: Long, store: DeskStore?) {
    var expanded by rememberSaveable("chip-${unit.message.info.id}") { mutableStateOf(false) }
    val author = unit.author
    val provenance = unit.provenance
    val recipient = (provenance as? Provenance.Mail)?.recipient?.takeIf { it.isNotBlank() && it != lane }
    val summary = listOfNotNull(author.label, recipient?.let { "→ $it" }).joinToString(" ")
    val description = "${author.description}, ${if (expanded) "expanded" else "collapsed"}"
    val tint = if (author is Author.Agent && author.unverified) Ink.Amber else Ink.Violet
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 3.dp)
            .background(tint.copy(alpha = if (expanded) 0.12f else 0.08f), RoundedCornerShape(12.dp))
            .clickable { expanded = !expanded }
            .semantics { contentDescription = description }
            .padding(horizontal = 12.dp),
    ) {
        Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (author is Author.Integration) Icons.Filled.Info else Icons.Filled.Email, null, tint = tint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Label(summary, color = tint, modifier = Modifier.weight(1f))
            Label(age(now, unit.message.info.time.created), color = Ink.Dim)
            Icon(if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, tint = Ink.Dim, modifier = Modifier.size(18.dp))
        }
        if (expanded) {
            val text = unit.message.parts.filter { it.type == "text" && !it.text.isNullOrBlank() }.joinToString("\n\n") { it.text!!.trim() }
            if (text.isNotBlank()) Text(markdownish(text), style = MaterialTheme.typography.bodyMedium, color = Ink.Text, modifier = Modifier.padding(bottom = 6.dp))
            if (store != null) ImageParts(unit.message.parts, store)
            provenance.detail()?.let { Mono(it, color = Ink.Muted, modifier = Modifier.padding(bottom = 10.dp)) }
        }
    }
}

// A run of chips and tool-only activity between two replies: "3 mail · 5 tools", collapsed by
// default; expanded shows every item in order, each still expandable on its own.
@Composable
fun ActivityStrip(strip: Timeline.Item.Strip, lane: String?, now: Long, store: DeskStore?) {
    val key = strip.units.first().message.info.id
    var expanded by rememberSaveable("strip-$key") { mutableStateOf(false) }
    val tint = if (strip.live) Ink.Green else Ink.Muted
    val description = "Activity: ${strip.label}, ${if (expanded) "expanded" else "collapsed"}"
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 3.dp).heightIn(min = 48.dp)
                .background(Ink.Panel, RoundedCornerShape(12.dp))
                .clickable { expanded = !expanded }
                .semantics { contentDescription = description }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (strip.live) StatusDot("busy", 6) else Icon(Icons.Filled.Email, null, tint = tint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Label(strip.label, color = tint, modifier = Modifier.weight(1f))
            Label(age(now, strip.units.last().message.info.time.created), color = Ink.Dim)
            Icon(if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, tint = Ink.Dim, modifier = Modifier.size(18.dp))
        }
        if (expanded) strip.units.forEach { unit ->
            when (unit) {
                is Timeline.Unit.Chip -> MailChip(unit, lane, now, store)
                is Timeline.Unit.Tools -> Column(Modifier.padding(horizontal = 20.dp, vertical = 2.dp)) {
                    ai.opencode.desk.ToolRows.groups(unit.message.parts).forEach { ToolGroupView(it, unit.message.info.id) }
                }
                else -> Unit
            }
        }
    }
}

// One timeline item as the lists draw it.
@Composable
fun TimelineItem(item: Timeline.Item, lane: String?, now: Long, store: DeskStore?) {
    when (item) {
        is Timeline.Item.Strip -> ActivityStrip(item, lane, now, store)
        is Timeline.Item.Single -> when (val unit = item.unit) {
            is Timeline.Unit.Chip -> MailChip(unit, lane, now, store)
            is Timeline.Unit.Tools, is Timeline.Unit.Reply -> Message(unit.message, now, null, true, store)
            is Timeline.Unit.Bubble -> Message(unit.message, now, unit.author, unit.first, store)
        }
    }
}

fun Timeline.Item.key(): String = when (this) {
    is Timeline.Item.Strip -> "strip-" + units.first().message.info.id
    is Timeline.Item.Single -> unit.message.info.id
}
