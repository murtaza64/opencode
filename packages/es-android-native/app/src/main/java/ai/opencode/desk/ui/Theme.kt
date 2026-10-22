package ai.opencode.desk.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// OLED black with saturated status colours (no pastels). One colour means one thing
// everywhere: amber = needs you, red = blocked, green = working, blue = the desk.
object Ink {
    val Black = Color(0xFF000000)
    val Panel = Color(0xFF121212)
    val Raised = Color(0xFF1C1C1E)
    val Line = Color(0xFF2A2A2E)
    val Text = Color(0xFFF2F2F2)
    val Muted = Color(0xFF9A9AA3)
    val Dim = Color(0xFF5C5C66)
    val Amber = Color(0xFFFFB000)
    val Red = Color(0xFFFF3B30)
    val Green = Color(0xFF2EE56A)
    val Blue = Color(0xFF3D8BFF)
    val Violet = Color(0xFFB266FF)
}

fun statusColor(status: String) = when (status) {
    "busy" -> Ink.Green
    "parked" -> Ink.Violet
    "retry", "error" -> Ink.Red
    else -> Ink.Dim
}

fun kindColor(kind: String) = if (kind == "blocker") Ink.Red else Ink.Amber

// Three text styles only: Title, Body, Label (mono caps for metadata).
val DeskType = Typography(
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, color = Ink.Text),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, color = Ink.Text),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Normal, color = Ink.Text),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal, color = Ink.Muted),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontFamily = FontFamily.Monospace, letterSpacing = 0.6.sp, color = Ink.Muted),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace, letterSpacing = 0.4.sp, color = Ink.Muted),
)

private val Scheme = darkColorScheme(
    primary = Ink.Blue,
    onPrimary = Ink.Black,
    secondary = Ink.Amber,
    onSecondary = Ink.Black,
    tertiary = Ink.Green,
    error = Ink.Red,
    background = Ink.Black,
    onBackground = Ink.Text,
    surface = Ink.Black,
    onSurface = Ink.Text,
    surfaceVariant = Ink.Panel,
    onSurfaceVariant = Ink.Muted,
    surfaceContainer = Ink.Panel,
    surfaceContainerHigh = Ink.Raised,
    surfaceContainerHighest = Ink.Raised,
    surfaceContainerLow = Ink.Panel,
    surfaceContainerLowest = Ink.Black,
    outline = Ink.Line,
    outlineVariant = Ink.Line,
)

@Composable
fun DeskTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = Scheme,
        typography = DeskType,
        shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(14.dp), large = RoundedCornerShape(24.dp)),
        content = content,
    )
}

// A status dot that breathes while the agent is working, so motion itself says "live".
@Composable
fun StatusDot(status: String, size: Int = 10) {
    val color = statusColor(status)
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
        initialValue = 1f, targetValue = if (status == "busy") 0.35f else 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "alpha",
    )
    Box(Modifier.size(size.dp).alpha(pulse).background(color, CircleShape))
}

@Composable
fun Label(text: String, color: Color = Ink.Muted, modifier: Modifier = Modifier, align: TextAlign? = null) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = color, modifier = modifier, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = align)
}

// Mono without the uppercase: for paths, commands and other case-sensitive detail.
@Composable
fun Mono(text: String, color: Color = Ink.Muted, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = color, modifier = modifier, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

// Enough markdown for agent prose on a phone: **bold**, `code`, and # headings as bold lines.
// Links, tables and fenced blocks stay literal on purpose; the desktop app is the place for those.
fun markdownish(text: String): AnnotatedString = buildAnnotatedString {
    text.lines().forEachIndexed { index, rawLine ->
        if (index > 0) append("\n")
        val heading = rawLine.startsWith("#")
        val line = if (heading) rawLine.trimStart('#').trim() else rawLine
        if (heading) pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
        var position = 0
        for (match in Regex("\\*\\*(.+?)\\*\\*|`([^`]+)`").findAll(line)) {
            append(line.substring(position, match.range.first))
            val bold = match.groups[1]?.value
            if (bold != null) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(bold) }
            else withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Ink.Raised)) { append(match.groups[2]!!.value) }
            position = match.range.last + 1
        }
        append(line.substring(position))
        if (heading) pop()
    }
}

fun age(now: Long, at: Long): String {
    if (at <= 0) return "—"
    val seconds = ((now - at) / 1000).coerceAtLeast(0)
    return when {
        seconds < 45 -> "now"
        seconds < 3600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3600}h"
        else -> "${seconds / 86_400}d"
    }
}
