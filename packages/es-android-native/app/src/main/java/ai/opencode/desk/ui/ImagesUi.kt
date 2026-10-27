package ai.opencode.desk.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ai.opencode.desk.DeskStore
import ai.opencode.desk.ImageIO
import ai.opencode.desk.ImageLayout
import ai.opencode.desk.ImagePolicy
import ai.opencode.desk.StoredImage
import ai.opencode.desk.model.Part
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Base64

// Photo Picker entry: no storage permission, images only, up to the remaining slots.
@Composable
fun AttachButton(store: DeskStore, sessionID: String, onError: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    val remaining = ImagePolicy.MAX_COUNT - (store.drafts[sessionID]?.images?.size ?: 0)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxItems = ImagePolicy.MAX_COUNT)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch { onError(store.attach(sessionID, uris.take(remaining.coerceAtLeast(1)))) }
    }
    IconButton(enabled = remaining > 0, modifier = Modifier.testTag("attach"), onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
        Icon(Icons.Filled.AddCircle, "Attach images", tint = if (remaining > 0) Ink.Muted else Ink.Dim)
    }
}

// Thumbnails of the images queued for the next send, each removable before sending.
@Composable
fun DraftStrip(store: DeskStore, sessionID: String) {
    val draft = store.drafts[sessionID] ?: return
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 6.dp).testTag("draft-images")) {
        items(draft.images, key = { it.path }) { image ->
            Box(Modifier.size(64.dp)) {
                StoredThumb(store, image, Modifier.fillMaxSize().clip(RoundedCornerShape(2.dp)))
                Box(
                    Modifier.align(Alignment.TopEnd).padding(2.dp).size(20.dp).background(Ink.Black.copy(alpha = 0.7f), CircleShape).clickable { store.detach(sessionID, image) }.testTag("remove-image"),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Close, "Remove image", tint = Ink.Text, modifier = Modifier.size(14.dp)) }
            }
        }
    }
}

@Composable
private fun StoredThumb(store: DeskStore, image: StoredImage, modifier: Modifier) {
    val bitmap by produceState<Bitmap?>(null, image.path) {
        value = withContext(Dispatchers.IO) { store.blobs.read(image.path)?.let { ImageIO.thumbnail(it, 256) } }
    }
    val bmp = bitmap
    if (bmp == null) Box(modifier.background(Ink.Raised)) else Image(bmp.asImageBitmap(), null, modifier, contentScale = ContentScale.Crop)
}

// One image source the inline preview can show: either a stored outbox image (pending bubble)
// or a transcript file part (accepted message). Dimensions come from the record so the box is
// reserved before decode; both paths use the same composable, so acceptance changes colour only.
sealed interface Preview {
    val width: Int
    val height: Int
    val label: String
    data class Stored(val image: StoredImage) : Preview { override val width = image.width; override val height = image.height; override val label = image.filename ?: "Image" }
    data class Remote(val part: Part, override val width: Int, override val height: Int) : Preview { override val label = part.filename ?: "Image" }
}

// Inline previews inside a bubble (CHAT-PARTS §3): one image at natural aspect within
// 360x280dp; several as a wrapping row of 160dp-tall tiles, gap 4dp, >4 → 3 + "+N".
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InlinePreviews(items: List<Preview>, store: DeskStore, modifier: Modifier = Modifier) {
    if (items.isEmpty()) return
    var open by remember { mutableStateOf<Preview?>(null) }
    BoxWithConstraints(modifier) {
        val column = maxWidth.value.toInt()
        if (items.size == 1) {
            val box = ImageLayout.single(items[0].width, items[0].height, column)
            PreviewTile(items[0], store, Modifier.size(box.width.dp, box.height.dp).clip(RoundedCornerShape(2.dp)).clickable { open = items[0] })
        } else FlowRow(horizontalArrangement = Arrangement.spacedBy(ImageLayout.GAP.dp), verticalArrangement = Arrangement.spacedBy(ImageLayout.GAP.dp)) {
            items.take(ImageLayout.visible(items.size)).forEach { item ->
                val box = ImageLayout.tile(item.width, item.height, column)
                PreviewTile(item, store, Modifier.size(box.width.dp, box.height.dp).clip(RoundedCornerShape(2.dp)).clickable { open = item })
            }
            val more = ImageLayout.overflow(items.size)
            if (more > 0) Box(Modifier.size(ImageLayout.ROW_H.dp).clip(RoundedCornerShape(2.dp)).background(Ink.Raised).clickable { open = items[ImageLayout.SHOW] }, contentAlignment = Alignment.Center) {
                Text("+$more", style = MaterialTheme.typography.titleMedium, color = Ink.Text)
            }
        }
    }
    open?.let { item -> when (item) { is Preview.Remote -> Viewer(item.part, store) { open = null }; is Preview.Stored -> StoredViewer(store, item.image) { open = null } } }
}

@Composable
private fun PreviewTile(item: Preview, store: DeskStore, modifier: Modifier) {
    when (item) {
        is Preview.Stored -> StoredThumb(store, item.image, modifier)
        is Preview.Remote -> TranscriptThumb(item.part, store, modifier)
    }
}

// Transcript file parts as previews. The server does not carry dimensions for file parts, so
// a transcript image reserves the default box; images this phone sent keep their stored box
// through the outbox record while it exists.
fun previews(parts: List<Part>, stored: List<StoredImage> = emptyList(), cached: Map<String, Pair<Int, Int>> = emptyMap()): List<Preview> =
    parts.filter { it.type == "file" && it.mime?.startsWith("image/") == true && it.url != null }.mapIndexed { index, part ->
        val known = stored.getOrNull(index)?.let { it.width to it.height } ?: cached[part.id] ?: (0 to 0)
        Preview.Remote(part, known.first, known.second)
    }

@Composable
fun ImageParts(parts: List<Part>, store: DeskStore, stored: List<StoredImage> = emptyList()) {
    InlinePreviews(previews(parts, stored, store.imageDims), store, Modifier.padding(top = 6.dp))
}

@Composable
private fun StoredViewer(store: DeskStore, image: StoredImage, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val bitmap by produceState<Bitmap?>(null, image.path) { value = withContext(Dispatchers.IO) { store.blobs.read(image.path)?.let { ImageIO.thumbnail(it, 2048) } } }
        Box(Modifier.fillMaxSize().background(Ink.Black).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
            bitmap?.let { Image(it.asImageBitmap(), image.filename ?: "image", Modifier.fillMaxSize(), contentScale = ContentScale.Fit) } ?: Text("Loading…", color = Ink.Muted)
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)) { Icon(Icons.Filled.Close, "Close", tint = Ink.Text) }
        }
    }
}

// Loads one image according to the origin guard: inline data decodes locally, same-origin
// http(s) goes through the authenticated gateway client, anything else is a placeholder.
@Composable
private fun loadImage(part: Part, store: DeskStore, targetWidth: Int): Pair<Bitmap?, String?> {
    val state by produceState<Pair<Bitmap?, String?>>(null to null, part.id, targetWidth) {
        value = withContext(Dispatchers.IO) {
            val decoded: Pair<Bitmap?, String?> = when (val fetch = ImagePolicy.classify(part.url.orEmpty(), part.mime.orEmpty(), store.gateway.origin)) {
                is ImagePolicy.Fetch.Inline -> runCatching { Base64.getDecoder().decode(fetch.base64) }.getOrNull()?.let { bytes -> ImageIO.bounds(bytes)?.let { store.imageDims.putIfAbsent(part.id, it) }; ImageIO.thumbnail(bytes, targetWidth) } to null
                is ImagePolicy.Fetch.SameOrigin -> runCatching { store.gateway.bytes(fetch.url) }.fold({ bytes -> ImageIO.bounds(bytes)?.let { store.imageDims.putIfAbsent(part.id, it) }; ImageIO.thumbnail(bytes, targetWidth) to null }, { null to "unavailable" })
                ImagePolicy.Fetch.External -> null to "external image"
            }
            decoded
        }
    }
    return state
}

@Composable
private fun TranscriptThumb(part: Part, store: DeskStore, modifier: Modifier) {
    val (bitmap, note) = loadImage(part, store, 256)
    when {
        bitmap != null -> Image(bitmap.asImageBitmap(), part.filename ?: "image", modifier, contentScale = ContentScale.Crop)
        else -> Box(modifier.background(Ink.Raised), contentAlignment = Alignment.Center) { Text(note ?: "…", style = MaterialTheme.typography.labelSmall, color = Ink.Muted) }
    }
}

// Full-screen viewer with pinch zoom and drag; tap the backdrop or Back to close.
@Composable
private fun Viewer(part: Part, store: DeskStore, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableStateOf(1f) }
        var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
        val (bitmap, note) = loadImage(part, store, 2048)
        Box(
            Modifier.fillMaxSize().background(Ink.Black).clickable(onClick = onClose).pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ -> scale = (scale * zoom).coerceIn(1f, 6f); offset += pan }
            },
            contentAlignment = Alignment.Center,
        ) {
            if (bitmap != null) Image(
                bitmap.asImageBitmap(), part.filename ?: "image",
                Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                contentScale = ContentScale.Fit,
            ) else Text(note ?: "Loading…", color = Ink.Muted)
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)) { Icon(Icons.Filled.Close, "Close", tint = Ink.Text) }
        }
    }
}
