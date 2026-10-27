package ai.opencode.desk

import ai.opencode.desk.net.AccessToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class CredKV : KeyValueWithKeys {
    val map = linkedMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    override fun keys() = map.keys.toList()
}

class CredentialsTest {
    private val laptop = "http://127.0.0.1:47120"
    private val excalibur = "https://agents.murtaza.earth"
    private val mini8443 = "https://mini.tail.ts.net:8443"
    private val mini443 = "https://mini.tail.ts.net"
    private val far = System.currentTimeMillis() + 86_400_000
    private fun fresh() = Credentials(CredKV(), CredKV())
    private fun pair(c: Credentials, origin: String) { c.saveCookie(origin, Credentials.Cookie("es_remote", "nonce.$origin", far)); c.touch(origin) }

    @Test
    fun cookies_never_cross_origins_even_on_the_same_host() {
        val c = fresh()
        pair(c, mini8443)
        assertTrue(c.paired(mini8443))
        assertFalse(c.paired(mini443))
        assertFalse(c.paired(excalibur))
        assertEquals(listOf("es_remote"), c.cookies(mini8443).map { it.name })
        assertTrue(c.cookies(mini443).isEmpty())
    }

    @Test
    fun access_token_is_per_exact_origin_and_never_leaks_on_switch() {
        val c = fresh()
        c.saveToken(excalibur, AccessToken("id-x", "secret-x"))
        assertEquals("id-x", c.token(excalibur)?.id)
        assertNull(c.token(mini8443))
        assertNull(c.token("http://agents.murtaza.earth"))
        assertNull(c.token("https://agents.murtaza.earth:8443"))
        assertEquals("id-x", c.token("https://AGENTS.murtaza.earth:443/")?.id)
    }

    @Test
    fun forgetting_one_origin_keeps_the_other_paired_with_its_token() {
        val c = fresh()
        pair(c, excalibur); c.saveToken(excalibur, AccessToken("id-x", "s"))
        pair(c, mini8443); c.saveToken(mini8443, AccessToken("id-m", "s"))
        c.forget(mini8443)
        assertFalse(c.paired(mini8443)); assertNull(c.token(mini8443))
        assertTrue(c.paired(excalibur)); assertEquals("id-x", c.token(excalibur)?.id)
        assertEquals(listOf("https://agents.murtaza.earth:443"), c.saved())
    }

    @Test
    fun saved_origins_are_most_recent_first_and_deduplicated() {
        val c = fresh()
        pair(c, laptop); pair(c, excalibur); c.touch(laptop)
        assertEquals(listOf("http://127.0.0.1:47120", "https://agents.murtaza.earth:443"), c.saved())
    }

    @Test
    fun expired_cookies_are_dropped_and_do_not_count_as_paired() {
        val c = fresh()
        c.saveCookie(laptop, Credentials.Cookie("es_remote", "old", System.currentTimeMillis() - 1))
        assertFalse(c.paired(laptop))
        assertTrue(c.cookies(laptop).isEmpty())
    }

    @Test
    fun migration_attaches_legacy_host_cookies_and_global_token_to_the_current_origin() {
        val plain = CredKV(); val secret = CredKV()
        plain.map["cookie:agents.murtaza.earth:es_remote"] = "legacy|$far"
        plain.map["cookie:agents.murtaza.earth:es_attention_operator"] = "op|$far"
        secret.map["access.id"] = "legacy-id"; secret.map["access.secret"] = "legacy-secret"
        val c = Credentials(plain, secret)
        c.migrate(excalibur, "agents.murtaza.earth")
        assertTrue(c.paired(excalibur))
        assertEquals(setOf("es_remote", "es_attention_operator"), c.cookies(excalibur).map { it.name }.toSet())
        assertEquals("legacy-id", c.token(excalibur)?.id)
        assertEquals(listOf("https://agents.murtaza.earth:443"), c.saved())
        assertNull(plain.map["cookie:agents.murtaza.earth:es_remote"])
        assertNull(secret.map["access.id"])
        assertNull(c.token(mini8443))
    }

    @Test
    fun migration_without_legacy_data_is_a_no_op() {
        val c = fresh()
        c.migrate(laptop, "127.0.0.1")
        assertFalse(c.paired(laptop)); assertTrue(c.saved().isEmpty())
    }

    @Test
    fun outbox_entries_from_another_origin_are_invisible_after_a_switch() {
        // Already enforced by OutboxStore keying; asserted here next to the credential rules.
        val kv = CredKV(); val blobs = object : BlobStore {
            val files = mutableMapOf<String, ByteArray>()
            override fun write(path: String, bytes: ByteArray) { files[path] = bytes }
            override fun read(path: String) = files[path]
            override fun delete(path: String) { files.remove(path) }
            override fun deleteAll(prefix: String) { files.keys.filter { it.startsWith(prefix) }.forEach { files.remove(it) } }
        }
        val store = OutboxStore(kv, blobs)
        store.put(OutboxEntry("req-1", excalibur, "ses", "/d", "hi", "steer", createdAt = 1))
        assertTrue(store.list(mini8443).isEmpty())
        assertNull(store.get(mini8443, "req-1"))
        assertEquals(1, store.list(excalibur).size)
    }
}
