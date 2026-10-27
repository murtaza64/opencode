package ai.opencode.desk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Author
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Provenance
import ai.opencode.desk.Timeline
import ai.opencode.desk.ToolRows
import ai.opencode.desk.detail
import ai.opencode.desk.Wake
import ai.opencode.desk.WakeEvent
import ai.opencode.desk.WakeEvidence
import ai.opencode.desk.WakeRules
import ai.opencode.desk.Timestamps
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import java.text.DateFormat
import java.util.Date

// Expanded ids for the transcript on screen: message ids for chips, and group keys. Kept by
// the screen (not the item) so a regroup that moves an item into a strip keeps it open.
val LocalExpanded = compositionLocalOf<SnapshotStateMap<String, Boolean>> { error("no expanded map") }

private val ChipShape = RoundedCornerShape(2.dp)

// Shared chip surface (CHAT-PARTS §2): content-sized up to 70% of the column, 2dp radius, quiet
// filled surface, no border; a 2dp accent ring only while focused. Logical alignment handles RTL.
@Composable
private fun ChipSurface(alignEnd: Boolean, description: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 3.dp)) {
        val cap = this.maxWidth * 0.7f
        Box(Modifier.fillMaxWidth(), contentAlignment = if (alignEnd) Alignment.CenterEnd else Alignment.CenterStart) {
            Column(
                Modifier
                    .widthIn(max = cap)
                    .clip(ChipShape)
                    .background(Ink.Panel)
                    .then(if (focused) Modifier.border(2.dp, Ink.Blue, ChipShape) else Modifier)
                    .clickable(interactionSource = interaction, indication = null, onClick = onClick)
                    .semantics { contentDescription = description }
                    .padding(horizontal = 10.dp),
            ) { content() }
        }
    }
}

// Mail chip. Collapsed: icon · other party (+ host glyph when cross-host) · purpose · actionable
// status only. No body, no kind duplicate, no timestamps. Expanded: body + images, then muted
// details (sender/recipient with sessions, absolute time, delivery, ids). Incoming aligns end
// like You; unknown direction aligns start, muted.
@Composable
fun MailChip(unit: Timeline.Unit.Chip, now: Long, store: DeskStore?, evidence: WakeEvidence? = null, agent: String = "the agent") {
    val expandedMap = LocalExpanded.current
    val id = unit.message.info.id
    val expanded = expandedMap[id] == true
    val line = Timeline.chipLine(unit)
    val wake = evidence?.wake
    val incoming = unit.direction == Timeline.Direction.Incoming
    val author = unit.author
    val tint = when {
        author is Author.Agent && author.unverified -> Ink.Amber
        unit.direction == Timeline.Direction.Unknown -> Ink.Muted
        else -> Ink.Violet
    }
    val wakeText = wake?.let { WakeRules.description(it, agent) }
    val description = "${author.description}${line.purpose?.let { ", $it" } ?: ""}${wakeText?.let { ", $it" } ?: ""}, ${if (expanded) "expanded" else "collapsed"}"
    ChipSurface(alignEnd = incoming, description = description, onClick = { expandedMap[id] = !expanded }) {
        Row(Modifier.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (author is Author.Integration) Icons.Filled.Info else Icons.Filled.Email, null, tint = tint, modifier = Modifier.size(14.dp))
            if (line.crossHost) { Spacer(Modifier.width(4.dp)); Icon(Icons.Filled.Share, null, tint = Ink.Dim, modifier = Modifier.size(11.dp)) }
            // Wake cue (§4): only `caused` draws attention (filled bolt, accent); unknown is a hollow dot; joined/none have no glyph.
            when (wake) {
                Wake.Caused -> { Spacer(Modifier.width(6.dp)); Bolt(Ink.Green, 13) }
                Wake.Unknown -> { Spacer(Modifier.width(6.dp)); Box(Modifier.size(7.dp).border(1.5.dp, Ink.Muted, androidx.compose.foundation.shape.CircleShape)) }
                else -> Unit
            }
            Spacer(Modifier.width(8.dp))
            Text(
                line.text, style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (wake == Wake.Caused) FontWeight.SemiBold else FontWeight.Normal,
                color = if (!incoming || wake == Wake.None) Ink.Muted else Ink.Text,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded) {
            val text = unit.message.parts.filter { it.type == "text" && !it.text.isNullOrBlank() }.joinToString("\n\n") { it.text!!.trim() }
            if (text.isNotBlank()) Text(markdownish(text), style = MaterialTheme.typography.bodyMedium, color = Ink.Text, modifier = Modifier.padding(bottom = 6.dp))
            if (store != null) ImageParts(unit.message.parts, store)
            Column(Modifier.padding(top = 4.dp, bottom = 10.dp)) {
                val p = unit.provenance
                if (p is Provenance.Mail) {
                    Mono("from ${p.sender}${p.senderSession?.let { " ($it)" } ?: ""}")
                    Mono("to ${p.recipient}")
                }
                if (unit.direction == Timeline.Direction.Unknown) Mono("direction unknown")
                Mono(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(unit.message.info.time.created)) + " · " + age(now, unit.message.info.time.created) + " ago")
                if (evidence != null) {
                    Mono(wakeText.orEmpty())
                    evidence.observedAt?.let { Mono("observed " + Timestamps.format(it)) }
                    evidence.presentedAt?.let { Mono("presented " + Timestamps.format(it)) }
                    evidence.handledAt?.let { Mono("handled " + Timestamps.format(it)) }
                } else Mono("in transcript (received)")
                p.detail()?.let { Mono(it) }
            }
        }
    }
}

// A run of tool-only assistant messages: same surface, start side, "N tools · <most significant
// action>" with a size bar; expands into the individual tool rows.
@Composable
fun ToolRunChip(run: Timeline.Item.ToolRun, now: Long) {
    val expandedMap = LocalExpanded.current
    val runKey = Timeline.key(run)
    val expanded = expandedMap[runKey] ?: Timeline.inheritsExpanded(run, expandedMap.filterValues { it }.keys)
    val tint = when { run.failed -> Ink.Red; run.live -> Ink.Green; else -> Ink.Muted }
    val label = "${run.count} tool${if (run.count == 1) "" else "s"}" + run.headline.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
    val description = "Tool run: $label, ${if (expanded) "expanded" else "collapsed"}"
    ChipSurface(alignEnd = false, description = description, onClick = { expandedMap[runKey] = !expanded }) {
        Row(Modifier.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            if (run.live) StatusDot("busy", 5) else Icon(Icons.Filled.Build, null, tint = tint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Mono(label, color = if (run.failed) Ink.Red else Ink.Text, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(8.dp))
            // Size bar: wider runs are visibly bigger, capped.
            Box(Modifier.width((6 + minOf(run.count, 20) * 2).dp).size(3.dp).background(tint, ChipShape))
        }
        if (expanded) Column(Modifier.padding(bottom = 8.dp)) {
            run.units.forEach { unit -> ToolRows.groups(unit.message.parts).forEach { ToolGroupView(it, unit.message.info.id) } }
        }
    }
}

// Consecutive incoming mail on the incoming side: "N mail · <latest party> · <status>", end-aligned
// like a chip, expands to the individual chips in order (each still expandable).
@Composable
fun IncomingStripChip(strip: Timeline.Item.IncomingStrip, now: Long, store: DeskStore?, evidence: (Timeline.Unit.Chip) -> WakeEvidence? = { null }, agent: String = "the agent") {
    val key = Timeline.key(strip)
    val expandedMap = LocalExpanded.current
    // Opens expanded when any member chip was expanded before finalization.
    val expanded = expandedMap[key] ?: Timeline.inheritsExpanded(strip, expandedMap.filterValues { it }.keys)
    val description = "Mail strip: ${strip.label}, ${if (expanded) "expanded" else "collapsed"}"
    Column(Modifier.fillMaxWidth()) {
        ChipSurface(alignEnd = true, description = description, onClick = { expandedMap[key] = !expanded }) {
            Row(Modifier.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Email, null, tint = Ink.Violet, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(8.dp))
                Text(strip.label, style = MaterialTheme.typography.bodyMedium, color = Ink.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (expanded) strip.chips.forEach { MailChip(it, now, store, evidence(it), agent) }
    }
}

// A wake marker row on the agent side (§4): thin, quiet, never restyles the mail it covers.
@Composable
fun WakeMarker(event: WakeEvent) {
    val label = WakeRules.markerLabel(event)
    val description = label + (event.at?.let { ", " + Timestamps.format(it) } ?: "") + (event.outcome?.let { ", $it" } ?: "")
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).semantics { contentDescription = description }, verticalAlignment = Alignment.CenterVertically) {
        Bolt(Ink.Dim, 12)
        Spacer(Modifier.width(8.dp))
        Mono(label, color = Ink.Dim)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).size(1.dp).background(Ink.Line))
    }
}

@Composable
fun TimelineItem(item: Timeline.Item, now: Long, store: DeskStore?, evidence: (Timeline.Unit.Chip) -> WakeEvidence? = { null }, agent: String = "the agent") {
    when (item) {
        is Timeline.Item.Marker -> WakeMarker(item.event)
        is Timeline.Item.IncomingStrip -> IncomingStripChip(item, now, store, evidence, agent)
        is Timeline.Item.ToolRun -> ToolRunChip(item, now)
        is Timeline.Item.Single -> when (val unit = item.unit) {
            is Timeline.Unit.Chip -> MailChip(unit, now, store, evidence(unit), agent)
            is Timeline.Unit.Tools, is Timeline.Unit.Reply -> Message(unit.message, now, null, true, store)
            is Timeline.Unit.Bubble -> Message(unit.message, now, unit.author, unit.first, store)
        }
    }
}

fun Timeline.Item.key(): String = Timeline.key(this)
