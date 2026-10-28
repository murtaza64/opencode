package ai.opencode.desk

import ai.opencode.desk.net.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostsTest {
    @Test
    fun glyphs_are_keyed_by_verified_host_id_only() {
        assertNull(Hosts.glyph("local"))
        assertEquals(Hosts.Glyph.Laptop, Hosts.glyph("laptop"))
        assertEquals(Hosts.Glyph.Ygnium, Hosts.glyph("ygnium"))
        assertEquals(Hosts.Glyph.Mini, Hosts.glyph("Mini"))
        assertEquals(Hosts.Glyph.Excalibur, Hosts.glyph("excalibur"))
        assertEquals(Hosts.Glyph.Wingman, Hosts.glyph("wingman"))
        assertNull(Hosts.glyph("gaming-pc"))
        assertNull(Hosts.glyph("Mac Mini"))
        assertNull(Hosts.glyph(null))
        assertNull(Hosts.glyph(""))
    }

    @Test
    fun display_names_and_labels_never_decide_the_glyph() {
        // A host whose id is unknown gets no glyph even if its label is a known machine name.
        val info = HostInfo(id = "pc-7", label = "Excalibur", remote = true)
        assertNull(Hosts.glyph(info.id))
        assertNull(Hosts.accessibleSuffix(info))
    }

    @Test
    fun accessible_suffix_uses_the_host_label() {
        assertEquals("on Mac Mini", Hosts.accessibleSuffix(HostInfo(id = "mini", label = "Mac Mini", remote = true)))
        assertNull(Hosts.accessibleSuffix(HostInfo()))
        assertEquals("on Local", Hosts.accessibleSuffix(HostInfo(self = "laptop")))
        assertEquals("on mini", Hosts.accessibleSuffix(HostInfo(id = "mini", label = "")))
        assertNull(Hosts.accessibleSuffix(null))
    }

    @Test
    fun wingman_lanes_draw_the_cloud_regardless_of_gateway_host() {
        val mini = HostInfo(id = "mini", label = "Mac Mini")
        assertEquals(Hosts.Glyph.Wingman, Hosts.forLane("wingman:abc", mini))
        assertEquals(Hosts.Glyph.Mini, Hosts.forLane("ses_123", mini))
        assertNull(Hosts.forLane("ses_123", HostInfo(id = "pc-7")))
    }

    @Test
    fun gateway_host_payload_parses() {
        val info = json.decodeFromString<HostInfo>("""{"id":"local","label":"Local","remote":false,"hosts":[{"id":"mini","label":"Mac Mini","origin":"https://mini.tail:8443"}]}""")
        assertEquals("local", info.id)
        assertEquals("mini", info.hosts.single().id)
    }
}
