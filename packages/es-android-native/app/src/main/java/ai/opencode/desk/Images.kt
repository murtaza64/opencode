package ai.opencode.desk

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Base64

// Client side of Core's image input contract (schema v1/input-image-validation.ts). Limits
// mirror the server so a bad pick is refused before any bytes leave the phone; the server
// remains the authority and its error strings are shown verbatim when it disagrees.
object ImagePolicy {
    val MIMES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    const val MAX_COUNT = 8
    const val MAX_BYTES = 5_242_880L
    const val MAX_TOTAL = 10_485_760L
    const val MAX_SIDE = 8192
    const val MAX_PIXELS = 16_777_216L

    fun fits(mime: String, bytes: Long, width: Int, height: Int) =
        mime in MIMES && bytes <= MAX_BYTES && width in 1..MAX_SIDE && height in 1..MAX_SIDE && width.toLong() * height <= MAX_PIXELS

    // Reason a set of normalised images cannot be sent, or null.
    fun issue(images: List<StoredImage>): String? {
        if (images.size > MAX_COUNT) return "At most $MAX_COUNT images are supported"
        images.forEach { if (it.mime !in MIMES) return "Unsupported image MIME: ${it.mime}" }
        images.forEach { if (it.bytes > MAX_BYTES) return "Image exceeds $MAX_BYTES bytes" }
        if (images.sumOf { it.bytes } > MAX_TOTAL) return "Images exceed $MAX_TOTAL total bytes"
        return null
    }

    fun dataUrl(mime: String, bytes: ByteArray) = "data:$mime;base64," + Base64.getEncoder().encodeToString(bytes)

    fun extension(mime: String) = when (mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/webp" -> "webp"; "image/gif" -> "gif"; else -> "bin" }

    // Transcript image URLs: inline data is decoded locally; http(s) is fetched with the
    // authenticated client only when scheme, host and port equal the configured origin, so the
    // pairing cookie and Access token never travel to another host. Everything else is a
    // placeholder without a fetch.
    sealed interface Fetch {
        data class Inline(val mime: String, val base64: String) : Fetch
        data class SameOrigin(val url: String) : Fetch
        data object External : Fetch
    }

    fun classify(url: String, mime: String, origin: String?): Fetch {
        if (url.startsWith("data:")) {
            val comma = url.indexOf(',')
            if (comma < 0) return Fetch.External
            val header = url.substring(5, comma)
            val declared = header.substringBefore(';').ifBlank { mime }
            if (!header.endsWith(";base64")) return Fetch.External
            return Fetch.Inline(declared, url.substring(comma + 1))
        }
        val target = url.toHttpUrlOrNull() ?: return Fetch.External
        val base = origin?.toHttpUrlOrNull() ?: return Fetch.External
        val same = target.scheme == base.scheme && target.host.equals(base.host, ignoreCase = true) && target.port == base.port
        return if (same) Fetch.SameOrigin(url) else Fetch.External
    }
}

// One normalised image in the durable outbox: bytes live at `path` under app-private storage.
@Serializable
data class StoredImage(val path: String, val mime: String, val bytes: Long, val width: Int, val height: Int, val filename: String? = null)

// Byte storage behind the outbox; the Android implementation is filesDir/outbox/<requestID>/.
interface BlobStore {
    fun write(path: String, bytes: ByteArray)
    fun read(path: String): ByteArray?
    fun delete(path: String)
    fun deleteAll(prefix: String)
}

// Durable record of a send: everything needed to repeat the identical POST with the same
// requestID after process death, bound to the gateway origin it was composed for.
@Serializable
data class OutboxEntry(
    val requestID: String,
    val origin: String,
    val sessionID: String,
    val directory: String,
    val text: String,
    val delivery: String,
    val images: List<StoredImage> = emptyList(),
    val createdAt: Long,
)

class OutboxStore(private val store: KeyValue, private val blobs: BlobStore) {
    private val json = ai.opencode.desk.net.json
    private fun key(origin: String) = "outbox:${DeskPointers.normalize(origin)}"

    fun list(origin: String): List<OutboxEntry> =
        store.get(key(origin))?.let { runCatching { json.decodeFromString(ListSerializer(OutboxEntry.serializer()), it) }.getOrNull() }.orEmpty()

    fun put(entry: OutboxEntry) {
        val others = list(entry.origin).filter { it.requestID != entry.requestID }
        store.put(key(entry.origin), json.encodeToString(ListSerializer(OutboxEntry.serializer()), others + entry))
    }

    // Removes the record and its bytes: on handled, on discard, or on cancel.
    fun remove(origin: String, requestID: String) {
        val remaining = list(origin).filter { it.requestID != requestID }
        store.put(key(origin), if (remaining.isEmpty()) null else json.encodeToString(ListSerializer(OutboxEntry.serializer()), remaining))
        blobs.deleteAll("outbox/$requestID/")
    }

    fun get(origin: String, requestID: String) = list(origin).firstOrNull { it.requestID == requestID }

    // The exact request body images for an entry: same bytes, same order, every time.
    fun payload(entry: OutboxEntry): JsonArray? {
        if (entry.images.isEmpty()) return null
        return JsonArray(entry.images.map { image ->
            val bytes = blobs.read(image.path) ?: throw IllegalStateException("Stored image missing: ${image.path}")
            buildJsonObject {
                put("type", "file")
                put("mime", image.mime)
                put("url", ImagePolicy.dataUrl(image.mime, bytes))
                if (image.filename != null) put("filename", image.filename)
            }
        })
    }

    fun store(requestID: String, index: Int, mime: String, bytes: ByteArray): String {
        val path = "outbox/$requestID/$index.${ImagePolicy.extension(mime)}"
        blobs.write(path, bytes)
        return path
    }
}
