package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.net.GatewayError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class FleetTest {
    private val mini = "http://127.0.0.1:47130"
    private val laptop = "https://murtaza-macbook-pro-1.tailc81fd.ts.net:8443"

    @Test
    fun reach_is_classified_by_cause() {
        assertEquals(Fleet.Reach.Auth, Fleet.classify(ai.opencode.desk.net.AccessRequired()))
        assertEquals(Fleet.Reach.Profile, Fleet.classify(ai.opencode.desk.net.PairingRequired()))
        assertEquals(Fleet.Reach.Server, Fleet.classify(GatewayError(502, "HTTP 502")))
        assertEquals(Fleet.Reach.Auth, Fleet.classify(GatewayError(403, "HTTP 403")))
        assertEquals(Fleet.Reach.Network, Fleet.classify(java.net.ConnectException("refused")))
    }

    @Test
    fun primary_rows_keep_bare_keys_and_other_hosts_are_prefixed_by_tag() {
        assertEquals("", Fleet.keyPrefix(mini, mini))
        assertEquals("", Fleet.keyPrefix("http://127.0.0.1:47130/", mini))
        assertEquals("murtaza-macbook-pro-1.tailc81fd.ts.net|", Fleet.keyPrefix(laptop, mini))
        assertEquals("murtaza-macbook-pro-1.tailc81fd.ts.net", Fleet.tag(laptop))
    }

    @Test
    fun host_label_is_the_verified_id_never_the_origin_when_known() {
        assertEquals("Mini", Fleet.Host(laptop, id = "mini").label)
        assertEquals("murtaza-macbook-pro-1.tailc81fd.ts.net", Fleet.Host(laptop, id = "local").label)
        assertEquals("murtaza-macbook-pro-1.tailc81fd.ts.net", Fleet.Host(laptop).label)
    }

    @Test
    fun work_today_sums_only_today_per_host_and_marks_partial_when_a_host_is_down() {
        val zone = ZoneId.of("UTC")
        val now = 1_761_600_000_000L // 2026-10-27T20:00:00Z
        val today = now - 3_600_000.0
        val yesterday = now - 30 * 3_600_000.0
        val sessions = mapOf(
            mini to listOf(DashSession("a", "", "idle", today, 1.5, ""), DashSession("b", "", "idle", yesterday, 9.0, "")),
            laptop to listOf(DashSession("c", "", "busy", today, 2.25, "")),
        )
        val ok = Fleet.workToday(sessions, listOf(Fleet.Host(mini, Fleet.Reach.Ok, lastSeen = now), Fleet.Host(laptop, Fleet.Reach.Ok, lastSeen = now - 5)), now, zone)
        assertEquals(3.75, ok.total, 1e-9)
        assertEquals(1.5, ok.perHost[mini]!!, 1e-9)
        assertFalse(ok.partial)
        assertEquals(now - 5, ok.observedAt[laptop])
        val down = Fleet.workToday(sessions.filterKeys { it == mini }, listOf(Fleet.Host(mini, Fleet.Reach.Ok, lastSeen = now), Fleet.Host(laptop, Fleet.Reach.Network, lastSeen = 0)), now, zone)
        assertTrue(down.partial)
        assertEquals(1.5, down.total, 1e-9)
        assertFalse(down.observedAt.containsKey(laptop))
    }
}
