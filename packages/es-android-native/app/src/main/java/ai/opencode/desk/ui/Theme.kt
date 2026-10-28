package ai.opencode.desk.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.core.graphics.drawable.toBitmap
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
    "busy", "retry" -> Ink.Green
    "parked" -> Ink.Violet
    "starting" -> Ink.Amber
    "error", "failed" -> Ink.Red
    "unread" -> Ink.Blue
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
        shapes = Shapes(small = RoundedCornerShape(2.dp), medium = RoundedCornerShape(4.dp), large = RoundedCornerShape(4.dp)),
        content = content,
    )
}

// The one busy idiom (CHAT-PARTS §1): a 7dp circle; busy = accent dot with a soft halo. Only the
// indicator for the thing the screen is about animates (`animate = true`), everything else is static.
// The halo animates alpha + scale, 1.6 s ease-in-out, compositor-only; reduced motion (animator
// duration scale 0) shows a static halo at 50%.
val LocalReducedMotion = compositionLocalOf { false }

@Composable
fun StatusDot(status: String, size: Int = 7, animate: Boolean = false) {
    val color = statusColor(status)
    val busy = status == "busy" || status == "retry"
    val hollow = status == "unknown" || status == "starting"
    val reduced = LocalReducedMotion.current
    Box(Modifier.size((size * 2).dp), contentAlignment = Alignment.Center) {
        if (busy) {
            if (animate && !reduced) {
                val halo by rememberInfiniteTransition(label = "halo").animateFloat(
                    initialValue = 0f, targetValue = 1f,
                    animationSpec = infiniteRepeatable(tween(1600, easing = EaseInOut), RepeatMode.Restart), label = "halo",
                )
                Box(Modifier.size((size * 2).dp).graphicsLayer { scaleX = 0.6f + halo * 0.6f; scaleY = 0.6f + halo * 0.6f; alpha = (1f - halo) * 0.45f }.background(color, CircleShape))
            } else Box(Modifier.size((size * 1.6f).dp).alpha(if (animate) 0.5f else 0.25f).background(color, CircleShape))
        }
        if (hollow) Box(Modifier.size(size.dp).border(1.5.dp, color, CircleShape))
        else Box(Modifier.size(size.dp).background(color, CircleShape))
    }
}

@Composable
fun Label(text: String, color: Color = Ink.Muted, modifier: Modifier = Modifier, align: TextAlign? = null) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = color, modifier = modifier, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = align)
}

// Mono without the uppercase: for paths, commands and other case-sensitive detail.
@Composable
fun Mono(text: String, color: Color = Ink.Muted, modifier: Modifier = Modifier, lines: Int = 1) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = color, modifier = modifier, maxLines = lines, overflow = TextOverflow.Ellipsis)
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

// Header action to switch to the other profile's Desk. Hidden when the other profile has no
// Desk. Label and icon come from Android so they match the launcher's own wording.
@Composable
fun ProfileSwitchAction(store: ai.opencode.desk.DeskStore, modifier: Modifier = Modifier) {
    val decision = store.profileSwitch
    if (!decision.visible) return
    val icon = androidx.compose.runtime.remember(decision.label) { store.profiles.icon() }
    androidx.compose.foundation.layout.Row(
        modifier.clip(RoundedCornerShape(2.dp)).background(Ink.Panel).clickable { store.profiles.switch() }.padding(horizontal = 8.dp, vertical = 6.dp).testTag("profile-switch"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let { androidx.compose.foundation.Image(androidx.compose.ui.graphics.painter.BitmapPainter(it.toBitmap(40, 40).asImageBitmap()), null, Modifier.size(14.dp)) }
        if (icon != null) androidx.compose.foundation.layout.Spacer(Modifier.width(6.dp))
        Label(decision.label.orEmpty(), color = Ink.Text)
    }
}

// A small filled lightning bolt, drawn rather than pulled from the extended icon set.
@Composable
fun Bolt(color: Color, size: Int = 13, modifier: Modifier = Modifier) {
    androidx.compose.foundation.Canvas(modifier.size(size.dp)) {
        val w = this.size.width; val h = this.size.height
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.62f, 0f); lineTo(w * 0.18f, h * 0.58f); lineTo(w * 0.48f, h * 0.58f)
            lineTo(w * 0.38f, h); lineTo(w * 0.84f, h * 0.40f); lineTo(w * 0.54f, h * 0.40f); close()
        }
        drawPath(path, color)
    }
}

// Location glyph before a title (DESK-AND-SIDEBARS §4): 12dp, current text colour, same optical
// weight for every host. Nothing is drawn for an unverified host.
@Composable
fun HostGlyph(glyph: ai.opencode.desk.Hosts.Glyph?, color: Color = Ink.Muted, size: Int = 12) {
    if (glyph == null) return
    val id = when (glyph) {
        ai.opencode.desk.Hosts.Glyph.Laptop -> ai.opencode.desk.R.drawable.host_laptop
        ai.opencode.desk.Hosts.Glyph.Ygnium -> ai.opencode.desk.R.drawable.host_ygnium
        ai.opencode.desk.Hosts.Glyph.Mini -> ai.opencode.desk.R.drawable.host_mini
        ai.opencode.desk.Hosts.Glyph.Excalibur -> ai.opencode.desk.R.drawable.host_excalibur
        ai.opencode.desk.Hosts.Glyph.Wingman -> ai.opencode.desk.R.drawable.host_wingman
    }
    androidx.compose.material3.Icon(androidx.compose.ui.res.painterResource(id), contentDescription = null, tint = color, modifier = Modifier.size(size.dp).padding(end = 0.dp))
}
