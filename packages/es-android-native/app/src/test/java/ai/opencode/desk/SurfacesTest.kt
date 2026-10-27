package ai.opencode.desk

import ai.opencode.desk.net.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfaceRegistryTest {
    @Test
    fun registry_record_parses_in_the_dashboard_shape() {
        val body = """{"surfaces":[{"id":"relay-board","title":"Relay board","summary":"Current work","kind":"url","owner":"Relay","lane":"orchestrator","editspace":"opencode","updated_at":1792723318039,"revision":1,"health":{"state":"ok","status":200,"checked_at":1793124956587,"since":1793124821722,"last_ok_at":1793124956587},"purpose":"board","created_at":1792723318039,"upstream":"http://127.0.0.1:64878/"}]}"""
        val surface = json.decodeFromString<SurfacesResponse>(body).surfaces.single()
        assertEquals("relay-board", surface.id)
        assertEquals("Relay", surface.owner)
        assertEquals("ok", surface.health.state)
        assertEquals(200, surface.health.status)
        assertFalse(surface.deliverable)
        assertFalse(surface.unseen)
    }

    @Test
    fun deliverables_expose_seen_state_and_boards_do_not() {
        val body = """{"surfaces":[{"id":"q4-deck","title":"Q4 deck","kind":"path","owner":"front-desk","editspace":"opencode","updated_at":5,"revision":3,"health":{"state":"error","detail":"index.html missing"},"purpose":"deliverable","requested_in":"ses_x","seen":false,"seen_at":null},{"id":"b","title":"B","owner":"o","editspace":"e","health":{"state":"unreachable","detail":"ConnectError"}}]}"""
        val (deck, board) = json.decodeFromString<SurfacesResponse>(body).surfaces
        assertTrue(deck.deliverable && deck.unseen)
        assertEquals("index.html missing", deck.health.detail)
        assertNull(board.seen)
        assertFalse(board.unseen)
        assertEquals("unreachable", board.health.state)
    }

    @Test
    fun surface_address_parses() {
        assertEquals("/__surface/relay-board/0123456789abcdef0123456789abcdef/", json.decodeFromString<SurfaceAddress>("""{"src":"/__surface/relay-board/0123456789abcdef0123456789abcdef/"}""").src)
    }
}

class SurfacePolicyTest {
    private val origin = "https://agents.murtaza.earth"
    private val cap = "0123456789abcdef0123456789abcdef"
    private val scope = SurfacePolicy.scope(origin, "/__surface/relay-board/$cap/")!!

    @Test
    fun scope_accepts_only_the_gateway_src_shape() {
        assertEquals("relay-board", scope.id)
        assertEquals("/__surface/relay-board/$cap/", scope.prefix)
        assertEquals("https://agents.murtaza.earth/__surface/relay-board/$cap/", SurfacePolicy.entry(scope))
        assertNull(SurfacePolicy.scope(origin, "/__surface/relay-board/$cap/index.html"))
        assertNull(SurfacePolicy.scope(origin, "/__surface/Relay/$cap/"))
        assertNull(SurfacePolicy.scope(origin, "/__surface/relay-board/short/"))
        assertNull(SurfacePolicy.scope(origin, "https://evil.example/__surface/relay-board/$cap/"))
        assertNull(SurfacePolicy.scope("not a url", "/__surface/relay-board/$cap/"))
    }

    @Test
    fun navigation_allows_only_the_same_prefix_on_the_same_origin() {
        assertEquals(SurfacePolicy.Nav.Allow, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/__surface/relay-board/$cap/page/2?x=1"))
        assertEquals(SurfacePolicy.Nav.Allow, SurfacePolicy.navigation(scope, "https://AGENTS.murtaza.earth:443/__surface/relay-board/$cap/"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/__surface/other-board/$cap/"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/__surface/relay-board/ffffffffffffffffffffffffffffffff/"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/oc/session"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/es/api/state"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "https://agents.murtaza.earth/"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "http://agents.murtaza.earth/__surface/relay-board/$cap/"))
    }

    @Test
    fun foreign_http_links_are_external_after_confirmation_and_other_schemes_are_blocked() {
        assertEquals(SurfacePolicy.Nav.External("https://github.com/murtaza64/dotfiles/issues/244"), SurfacePolicy.navigation(scope, "https://github.com/murtaza64/dotfiles/issues/244"))
        assertEquals(SurfacePolicy.Nav.External("http://example.com/"), SurfacePolicy.navigation(scope, "http://example.com/"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "file:///etc/hosts"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "javascript:alert(1)"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "intent://x#Intent;scheme=zxing;end"))
        assertEquals(SurfacePolicy.Nav.Block, SurfacePolicy.navigation(scope, "content://media/1"))
    }

    @Test
    fun interception_carries_the_token_only_for_get_and_head_inside_the_prefix() {
        val inside = "https://agents.murtaza.earth/__surface/relay-board/$cap/app.js"
        assertEquals(SurfacePolicy.Intercept.Fetch(inside), SurfacePolicy.intercept(scope, "GET", inside, hasToken = true))
        assertEquals(SurfacePolicy.Intercept.Fetch(inside), SurfacePolicy.intercept(scope, "HEAD", inside, hasToken = true))
        assertTrue(SurfacePolicy.intercept(scope, "POST", inside, hasToken = true) is SurfacePolicy.Intercept.Refuse)
        assertTrue(SurfacePolicy.intercept(scope, "PUT", inside, hasToken = true) is SurfacePolicy.Intercept.Refuse)
    }

    @Test
    fun without_a_token_same_origin_requests_pass_through_to_the_webview() {
        val inside = "https://agents.murtaza.earth/__surface/relay-board/$cap/app.js"
        assertEquals(SurfacePolicy.Intercept.PassThrough, SurfacePolicy.intercept(scope, "GET", inside, hasToken = false))
        assertEquals(SurfacePolicy.Intercept.PassThrough, SurfacePolicy.intercept(scope, "POST", inside, hasToken = false))
    }

    @Test
    fun foreign_hosts_are_never_intercepted_and_same_origin_outside_the_prefix_is_refused() {
        assertEquals(SurfacePolicy.Intercept.PassThrough, SurfacePolicy.intercept(scope, "GET", "https://cdn.example/lib.js", hasToken = true))
        assertEquals(SurfacePolicy.Intercept.PassThrough, SurfacePolicy.intercept(scope, "GET", "http://agents.murtaza.earth/__surface/relay-board/$cap/x", hasToken = true))
        assertTrue(SurfacePolicy.intercept(scope, "GET", "https://agents.murtaza.earth/oc/session", hasToken = true) is SurfacePolicy.Intercept.Refuse)
        assertTrue(SurfacePolicy.intercept(scope, "GET", "https://agents.murtaza.earth/__surface/other/$cap/", hasToken = true) is SurfacePolicy.Intercept.Refuse)
    }
}
