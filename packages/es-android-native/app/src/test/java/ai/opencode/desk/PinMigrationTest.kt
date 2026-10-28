package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// android-lead#69: a pin made on 0.1.16 must survive an upgrade and a re-pairing of the same
// host under another origin spelling. Pins of a different host are never adopted.
class PinMigrationTest {
    private class Fake : KeyValueWithKeys {
        val m = LinkedHashMap<String, String>()
        override fun get(key: String) = m[key]
        override fun put(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
        override fun keys() = m.keys.toList()
    }

    private val legacy = """[{"editspace":"opencode","lane":"orchestrator"}]"""

    @Test
    fun a_0_1_16_pin_list_decodes_unchanged() {
        val kv = Fake(); kv.m["pins:http://100.64.0.2:47130"] = legacy
        assertEquals(listOf(Pin("opencode", "orchestrator")), PinStore(kv).list("http://100.64.0.2:47130"))
    }

    @Test
    fun same_host_repaired_with_another_scheme_or_port_keeps_its_pins() {
        val kv = Fake(); kv.m["pins:http://murtaza-mini.tailc81fd.ts.net:47130"] = legacy
        val pins = PinStore(kv).adopt("https://murtaza-mini.tailc81fd.ts.net:8443")
        assertEquals(listOf(Pin("opencode", "orchestrator")), pins)
        // Adopted once, then it is the new origin's own list.
        assertEquals(pins, PinStore(kv).list("https://murtaza-mini.tailc81fd.ts.net:8443"))
    }

    @Test
    fun a_different_host_is_never_adopted_and_an_existing_list_is_never_overwritten() {
        val kv = Fake(); kv.m["pins:http://laptop.tailc81fd.ts.net:8443"] = legacy
        assertTrue(PinStore(kv).adopt("https://murtaza-mini.tailc81fd.ts.net:8443").isEmpty())
        kv.m["pins:https://murtaza-mini.tailc81fd.ts.net:8443"] = """[{"editspace":"dotfiles","lane":"joiner"}]"""
        kv.m["pins:http://murtaza-mini.tailc81fd.ts.net:47130"] = legacy
        assertEquals(listOf(Pin("dotfiles", "joiner")), PinStore(kv).adopt("https://murtaza-mini.tailc81fd.ts.net:8443"))
    }

    @Test
    fun every_stored_list_is_visible_for_diagnostics() {
        val kv = Fake(); kv.m["pins:http://a:1"] = legacy; kv.m["other"] = "x"
        assertEquals(setOf("http://a:1"), PinStore(kv).all().keys)
    }
}
