package ai.opencode.desk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Agent
import ai.opencode.desk.HostInfo
import ai.opencode.desk.Hosts
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import ai.opencode.desk.model.AttentionRecord

@Composable
fun SectionHeader(title: String, trailing: String? = null, onTrailing: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        if (trailing != null) Text(
            trailing, style = MaterialTheme.typography.labelMedium, color = Ink.Blue,
            modifier = if (onTrailing != null) Modifier.clickable(onClick = onTrailing).padding(4.dp) else Modifier,
        )
    }
}

@Composable
fun Chip(text: String, color: Color, filled: Boolean = false) {
    Box(
        Modifier
            .background(if (filled) color else color.copy(alpha = 0.14f), RoundedCornerShape(2.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) { Label(text, color = if (filled) Ink.Black else color) }
}

// A decision or blocker as one row: colour rail on the left says the kind at a glance,
// the title carries the ask, one line of context, then where it came from and how old.
@Composable
fun AttentionRow(record: AttentionRecord, now: Long, onClick: () -> Unit, host: HostInfo? = null) {
    val color = kindColor(record.kind)
    val glyph = Hosts.glyph(Hosts.resolve(host)?.id)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 12.dp, end = 20.dp, top = 12.dp, bottom = 12.dp)
            .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(record.kind, record.title, Hosts.accessibleSuffix(host)).joinToString(", ") },
    ) {
        Box(Modifier.width(4.dp).height(56.dp).background(color, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.Top) {
                if (glyph != null) { HostGlyph(glyph, size = 12); Spacer(Modifier.width(6.dp)) }
                Text(record.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (record.context.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(record.context.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(record.kind, color)
                val recommended = record.options.firstOrNull { it.id == record.recommendation }
                val hint = when {
                    recommended != null -> "→ ${recommended.label}"
                    record.options.isEmpty() -> "open question"
                    else -> "${record.options.size} options"
                }
                Label(hint, color = if (recommended != null) Ink.Text else Ink.Muted, modifier = Modifier.weight(1f))
                Label(listOfNotNull(record.editspace, record.lane).joinToString("/") + " · " + age(now, record.updated_at), modifier = Modifier.widthIn(max = 150.dp), align = TextAlign.End)
            }
        }
    }
    HorizontalDivider(color = Ink.Line, thickness = 0.5.dp, modifier = Modifier.padding(start = 30.dp))
}

@Composable
fun AgentRow(agent: Agent, now: Long, onClick: () -> Unit, trailing: (@Composable () -> Unit)? = null, host: HostInfo? = null, onOpenHistory: ((String) -> Unit)? = null) {
    val glyph = Hosts.forLane(agent.owner, host)
    val suffix = if (glyph == Hosts.Glyph.Wingman) "on Wingman" else Hosts.accessibleSuffix(host)
    val hostLabel = if (glyph == Hosts.Glyph.Wingman) "Wingman" else Hosts.resolve(host)?.takeIf { glyph != null }?.label
    var lineage by remember(agent.key) { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 20.dp, end = if (trailing != null) 4.dp else 20.dp, top = 12.dp, bottom = 12.dp)
            .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(agent.title, agent.laneLabel, agent.editspace, suffix, agent.status).joinToString(", ") },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(agent.status, 7)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (glyph != null) { HostGlyph(glyph); Spacer(Modifier.width(6.dp)) }
                Text(agent.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // Secondary line: lane · project · host, so a row is findable by any of them.
            Label(listOfNotNull(agent.lane.takeIf { it.isNotBlank() }, agent.editspace, hostLabel).joinToString(" · "))
            if (agent.activity.isNotBlank()) Text(agent.activity, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (onOpenHistory != null && agent.history.isNotEmpty()) {
                Label(if (lineage) "Earlier sessions ▾" else "Earlier sessions · ${agent.history.size} ▸", color = Ink.Blue, modifier = Modifier.clickable { lineage = !lineage }.padding(top = 4.dp, bottom = 2.dp).testTag("lineage-${agent.key}"))
                if (lineage) agent.history.forEach { old ->
                    Row(Modifier.clickable { onOpenHistory(old.id) }.padding(vertical = 3.dp).testTag("history-${old.id}"), verticalAlignment = Alignment.CenterVertically) {
                        Text(old.title.ifBlank { old.id }, style = MaterialTheme.typography.bodyMedium, color = Ink.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(8.dp)); Label("history")
                    }
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            Label(agent.status, color = statusColor(agent.status).takeIf { agent.status != "idle" } ?: Ink.Muted)
            Label(age(now, agent.activityAt))
        }
        trailing?.invoke()
    }
    HorizontalDivider(color = Ink.Line, thickness = 0.5.dp, modifier = Modifier.padding(start = 44.dp))
}
