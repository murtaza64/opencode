package ai.opencode.desk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.File

// App-private byte storage for outbox images: filesDir/outbox/<requestID>/<n>.<ext>.
class FileBlobStore(private val root: File) : BlobStore {
    private fun file(path: String) = File(root, path).also { require(it.canonicalPath.startsWith(root.canonicalPath)) }
    override fun write(path: String, bytes: ByteArray) { file(path).apply { parentFile?.mkdirs() }.writeBytes(bytes) }
    override fun read(path: String): ByteArray? = file(path).takeIf { it.isFile }?.readBytes()
    override fun delete(path: String) { file(path).delete() }
    override fun deleteAll(prefix: String) { file(prefix).deleteRecursively() }
}

data class Normalized(val mime: String, val bytes: ByteArray, val width: Int, val height: Int)

// Reads a picked image once, off the main thread, and brings it inside the server limits:
// PNG/GIF are kept verbatim when already within limits; everything else is decoded with
// subsampling to at most 8192px a side / 16 MP and re-encoded as JPEG (or WebP for sources
// with alpha) at a quality that lands under 5 MiB.
object ImageIO {
    fun normalize(context: Context, uri: Uri): Result<Normalized> = runCatching {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        val mime = bounds.outMimeType ?: resolver.getType(uri) ?: throw IllegalArgumentException("Not an image")
        val size = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0) throw IllegalArgumentException("Could not read image dimensions")
        if ((mime == "image/png" || mime == "image/gif") && size in 1..ImagePolicy.MAX_BYTES && ImagePolicy.fits(mime, size, width, height)) {
            val bytes = resolver.openInputStream(uri)!!.use { it.readBytes() }
            return@runCatching Normalized(mime, bytes, width, height)
        }
        var sample = 1
        while ((width / sample) > ImagePolicy.MAX_SIDE || (height / sample) > ImagePolicy.MAX_SIDE || (width.toLong() / sample) * (height / sample) > ImagePolicy.MAX_PIXELS) sample *= 2
        // Downscale beyond the hard limit too: a phone photo at 12 MP does not need to be 12 MP for a model.
        while ((width.toLong() / sample) * (height / sample) > 4_000_000L) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bitmap = resolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it, null, options) } ?: throw IllegalArgumentException("Could not decode image")
        val alpha = bitmap.hasAlpha() && mime != "image/jpeg"
        val format = if (alpha) webpFormat() else Bitmap.CompressFormat.JPEG
        val outMime = if (alpha) "image/webp" else "image/jpeg"
        var quality = 88
        var bytes: ByteArray
        do {
            bytes = ByteArrayOutputStream().also { bitmap.compress(format, quality, it) }.toByteArray()
            quality -= 12
        } while (bytes.size > ImagePolicy.MAX_BYTES && quality >= 40)
        val result = Normalized(outMime, bytes, bitmap.width, bitmap.height)
        bitmap.recycle()
        if (result.bytes.size > ImagePolicy.MAX_BYTES) throw IllegalArgumentException("Image is too large even after re-encoding")
        result
    }

    @Suppress("DEPRECATION")
    private fun webpFormat() = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP

    // Intrinsic dimensions without decoding pixels.
    fun bounds(bytes: ByteArray): Pair<Int, Int>? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        return if (o.outWidth > 0 && o.outHeight > 0) o.outWidth to o.outHeight else null
    }

    // Decodes bytes for display, subsampled to roughly the requested width.
    fun thumbnail(bytes: ByteArray, targetWidth: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / sample > targetWidth * 2) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
