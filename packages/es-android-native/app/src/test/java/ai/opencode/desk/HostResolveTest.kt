package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// BUG from android-lead#45: a gateway reports itself as "local"; that must resolve to the
// gateway machine's verified id, never to the laptop by default.
class HostResolveTest {
    @Test
    fun bare_local_draws_nothing() {
        assertNull(Hosts.glyph("local"))
        assertNull(Hosts.resolve(HostInfo(id = "local", label = "Local")))
        assertNull(Hosts.forLane("ses_x", HostInfo(id = "local", label = "Local")))
        assertNull(Hosts.accessibleSuffix(HostInfo(id = "local", label = "Local")))
    }

    @Test
    fun local_with_a_learned_self_id_resolves_to_that_machine() {
        assertEquals(Hosts.Glyph.Mini, Hosts.forLane("ses_x", HostInfo(id = "local", label = "Local", self = "mini")))
        assertEquals(Hosts.Glyph.Excalibur, Hosts.forLane("ses_x", HostInfo(id = "local", label = "Local", self = "excalibur")))
        assertEquals(Hosts.Glyph.Laptop, Hosts.forLane("ses_x", HostInfo(id = "local", label = "Local", self = "laptop")))
        assertEquals("on Local", Hosts.accessibleSuffix(HostInfo(id = "local", label = "Local", self = "mini")))
    }

    @Test
    fun an_unknown_self_or_label_draws_nothing() {
        assertNull(Hosts.resolve(HostInfo(id = "local", label = "Local", self = "pc-7")))
        assertNull(Hosts.resolve(HostInfo(id = "local", label = "Gaming rig")))
    }

    @Test
    fun a_known_label_alone_never_resolves() {
        assertNull(Hosts.forLane("ses_x", HostInfo(id = "local", label = "Mac Mini")))
        assertNull(Hosts.forLane("ses_x", HostInfo(id = "local", label = "excalibur")))
    }
}
