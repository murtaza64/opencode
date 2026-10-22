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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.opencode.desk.Agent
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
            .background(if (filled) color else color.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) { Label(text, color = if (filled) Ink.Black else color) }
}

// A decision or blocker as one row: colour rail on the left says the kind at a glance,
// the title carries the ask, one line of context, then where it came from and how old.
@Composable
fun AttentionRow(record: AttentionRecord, now: Long, onClick: () -> Unit) {
    val color = kindColor(record.kind)
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 12.dp, end = 20.dp, top = 12.dp, bottom = 12.dp)) {
        Box(Modifier.width(4.dp).height(56.dp).background(color, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(record.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
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
fun AgentRow(agent: Agent, now: Long, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(agent.status)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(agent.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (agent.activity.isNotBlank()) Text(agent.activity, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            Label(agent.status, color = statusColor(agent.status).takeIf { agent.status != "idle" } ?: Ink.Muted)
            Label(age(now, agent.activityAt))
        }
    }
    HorizontalDivider(color = Ink.Line, thickness = 0.5.dp, modifier = Modifier.padding(start = 44.dp))
}
