package ai.opencode.desk

import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class MemKV : KeyValue {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

private class MemBlobs : BlobStore {
    val files = mutableMapOf<String, ByteArray>()
    override fun write(path: String, bytes: ByteArray) { files[path] = bytes }
    override fun read(path: String) = files[path]
    override fun delete(path: String) { files.remove(path) }
    override fun deleteAll(prefix: String) { files.keys.filter { it.startsWith(prefix) }.forEach { files.remove(it) } }
}

class ImagePolicyTest {
    private fun img(bytes: Long, mime: String = "image/jpeg") = StoredImage("p", mime, bytes, 100, 100)

    @Test
    fun limits_mirror_the_server() {
        assertNull(ImagePolicy.issue(List(8) { img(1_000_000) }))
        assertEquals("At most 8 images are supported", ImagePolicy.issue(List(9) { img(10) }))
        assertEquals("Unsupported image MIME: image/bmp", ImagePolicy.issue(listOf(img(10, "image/bmp"))))
        assertEquals("Image exceeds 5242880 bytes", ImagePolicy.issue(listOf(img(5_242_881))))
        assertEquals("Images exceed 10485760 total bytes", ImagePolicy.issue(listOf(img(5_000_000), img(5_000_000), img(500_000))))
    }

    @Test
    fun fits_checks_dimensions_and_pixels() {
        assertTrue(ImagePolicy.fits("image/png", 10, 8192, 2048))
        assertFalse(ImagePolicy.fits("image/png", 10, 8193, 10))
        assertFalse(ImagePolicy.fits("image/png", 10, 4097, 4097))
        assertFalse(ImagePolicy.fits("image/png", 10, 0, 10))
    }

    @Test
    fun data_url_is_canonical_base64_with_the_mime_prefix() {
        assertEquals("data:image/png;base64,AQID", ImagePolicy.dataUrl("image/png", byteArrayOf(1, 2, 3)))
    }

    @Test
    fun transcript_url_guard_decodes_inline_fetches_same_origin_and_blocks_external() {
        val origin = "https://agents.murtaza.earth"
        assertEquals(ImagePolicy.Fetch.Inline("image/png", "AQID"), ImagePolicy.classify("data:image/png;base64,AQID", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.SameOrigin("https://agents.murtaza.earth/oc/file/x.png"), ImagePolicy.classify("https://agents.murtaza.earth/oc/file/x.png", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.SameOrigin("https://AGENTS.murtaza.earth:443/a"), ImagePolicy.classify("https://AGENTS.murtaza.earth:443/a", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.External, ImagePolicy.classify("https://evil.example/x.png", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.External, ImagePolicy.classify("http://agents.murtaza.earth/x.png", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.External, ImagePolicy.classify("https://agents.murtaza.earth:8443/x.png", "image/png", origin))
        assertEquals(ImagePolicy.Fetch.External, ImagePolicy.classify("https://agents.murtaza.earth/x.png", "image/png", null))
        assertEquals(ImagePolicy.Fetch.External, ImagePolicy.classify("data:image/png,notbase64", "image/png", origin))
    }

    @Test
    fun access_token_never_applies_to_an_external_image_host() {
        // The interceptor rule is the same one the transcript guard relies on: foreign host, no headers.
        val token = ai.opencode.desk.net.AccessToken("id", "secret")
        val request = okhttp3.Request.Builder().url("https://evil.example/x.png").build()
        assertNull(ai.opencode.desk.net.Access.authorize(request, "https://agents.murtaza.earth".toHttpUrl(), token).header(ai.opencode.desk.net.Access.SECRET_HEADER))
    }
}

class OutboxStoreTest {
    private val laptop = "http://127.0.0.1:47120"
    private val pc = "https://agents.murtaza.earth"

    private fun entryWithImages(store: OutboxStore, origin: String, requestID: String): OutboxEntry {
        val a = store.store(requestID, 0, "image/jpeg", byteArrayOf(1, 2, 3))
        val b = store.store(requestID, 1, "image/png", byteArrayOf(9, 8))
        val entry = OutboxEntry(requestID, origin, "ses_a", "/dir", "look", "steer", listOf(StoredImage(a, "image/jpeg", 3, 10, 10), StoredImage(b, "image/png", 2, 5, 5, "shot.png")), createdAt = 1)
        store.put(entry)
        return entry
    }

    @Test
    fun an_entry_survives_a_simulated_restart_with_its_bytes() {
        val kv = MemKV(); val blobs = MemBlobs()
        val entry = entryWithImages(OutboxStore(kv, blobs), pc, "req-1")
        val reloaded = OutboxStore(kv, blobs)
        assertEquals(listOf(entry), reloaded.list(pc))
        val payload = reloaded.payload(entry)!!
        assertEquals(2, payload.size)
        assertEquals("data:image/jpeg;base64,AQID", (payload[0] as JsonObject)["url"]!!.jsonPrimitive.content)
        assertEquals("shot.png", (payload[1] as JsonObject)["filename"]!!.jsonPrimitive.content)
    }

    @Test
    fun retry_payload_is_byte_identical_and_keeps_the_request_id() {
        val store = OutboxStore(MemKV(), MemBlobs())
        val entry = entryWithImages(store, pc, "req-2")
        val first = store.payload(store.get(pc, "req-2")!!).toString()
        val second = store.payload(store.get(pc, "req-2")!!).toString()
        assertEquals(first, second)
        assertEquals("req-2", store.get(pc, "req-2")!!.requestID)
        assertEquals(entry, store.get(pc, "req-2"))
    }

    @Test
    fun entries_are_bound_to_the_origin_they_were_composed_for() {
        val kv = MemKV(); val blobs = MemBlobs()
        val store = OutboxStore(kv, blobs)
        entryWithImages(store, laptop, "req-3")
        // After re-pairing to the PC the laptop's entry is not listed and is never replayed.
        assertTrue(store.list(pc).isEmpty())
        assertNull(store.get(pc, "req-3"))
        assertEquals(1, store.list(laptop).size)
        assertEquals(1, store.list("http://127.0.0.1:47120/").size)
    }

    @Test
    fun remove_drops_the_record_and_deletes_the_bytes() {
        val kv = MemKV(); val blobs = MemBlobs()
        val store = OutboxStore(kv, blobs)
        entryWithImages(store, pc, "req-4")
        entryWithImages(store, pc, "req-5")
        store.remove(pc, "req-4")
        assertEquals(listOf("req-5"), store.list(pc).map { it.requestID })
        assertTrue(blobs.files.keys.none { it.startsWith("outbox/req-4/") })
        assertEquals(2, blobs.files.keys.count { it.startsWith("outbox/req-5/") })
    }

    @Test
    fun text_only_entries_have_no_image_payload() {
        val store = OutboxStore(MemKV(), MemBlobs())
        val entry = OutboxEntry("req-6", pc, "ses", "/d", "hi", "queue", createdAt = 1)
        store.put(entry)
        assertNull(store.payload(entry))
    }

    @Test
    fun missing_bytes_fail_loudly_rather_than_sending_a_partial_set() {
        val kv = MemKV(); val blobs = MemBlobs()
        val store = OutboxStore(kv, blobs)
        val entry = entryWithImages(store, pc, "req-7")
        blobs.files.remove(entry.images[1].path)
        assertTrue(runCatching { store.payload(entry) }.isFailure)
    }

    @Test
    fun removing_a_drafted_image_before_send_leaves_the_rest_in_order() {
        val store = OutboxStore(MemKV(), MemBlobs())
        val entry = entryWithImages(store, pc, "req-8")
        val trimmed = entry.copy(images = entry.images - entry.images[0])
        store.put(trimmed)
        assertEquals(listOf("shot.png"), store.get(pc, "req-8")!!.images.map { it.filename })
        assertEquals(1, store.payload(store.get(pc, "req-8")!!)!!.jsonArray.size)
    }
}

class PendingLabelTest {
    @Test
    fun pending_label_shows_the_image_count() {
        val item = Pending("r", "s", "t", "steer", SendState.Accepted, createdAt = 1, images = 2)
        assertEquals("2 images · registered · next safe boundary", item.label)
        assertEquals("1 image · sending…", item.copy(images = 1, state = SendState.Sending).label)
        assertEquals("sending…", item.copy(images = 0, state = SendState.Sending).label)
    }
}
