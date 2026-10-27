package ai.opencode.desk

import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// Published surfaces: agent-maintained boards and deliverables served through the gateway
// at /__surface/<id>/<capability>/ (dotfiles es_dashboard_surfaces.py, opencode
// packages/es-app/surface-proxy.ts). Read-only on the phone: list and open; no seen-marking.

@Serializable
data class SurfaceHealth(val state: String = "unknown", val status: Int? = null, val detail: String? = null, val checked_at: Long? = null, val since: Long? = null, val last_ok_at: Long? = null)

@Serializable
data class Surface(
    val id: String,
    val title: String = "",
    val summary: String? = null,
    val kind: String = "",
    val owner: String = "",
    val lane: String? = null,
    val editspace: String = "",
    val purpose: String = "board",
    val revision: Int = 0,
    val updated_at: Long = 0,
    val created_at: Long? = null,
    val health: SurfaceHealth = SurfaceHealth(),
    val requested_in: String? = null,
    val seen: Boolean? = null,
    val seen_at: Long? = null,
) {
    val deliverable get() = purpose == "deliverable"
    // Deliverables carry `seen`; a false value means this revision has not been opened on the operator UI.
    val unseen get() = deliverable && seen == false
}

@Serializable
data class SurfacesResponse(val surfaces: List<Surface> = emptyList())

@Serializable
data class SurfaceAddress(val src: String)

object SurfacePolicy {
    private val PREFIX = Regex("^/__surface/([a-z0-9][a-z0-9-]{0,39})/([0-9a-f]{32})/")

    // The surface's own prefix: origin + /__surface/<id>/<capability>/ as returned by the gateway.
    data class Scope(val origin: HttpUrl, val id: String, val prefix: String)

    fun scope(origin: String, src: String): Scope? {
        val base = origin.toHttpUrlOrNull() ?: return null
        val match = PREFIX.find(src) ?: return null
        if (!src.startsWith(match.value) || src != match.value) return null
        return Scope(base, match.groupValues[1], match.value)
    }

    fun entry(scope: Scope) = scope.origin.newBuilder().encodedPath(scope.prefix).build().toString()

    sealed interface Nav {
        data object Allow : Nav
        data class External(val url: String) : Nav
        data object Block : Nav
    }

    // In-place navigation only inside the surface's own prefix on the configured origin.
    // http(s) elsewhere may open in the system browser after confirmation; everything else
    // (other surfaces, /oc, /es, file:, javascript:, intent:, custom schemes) is blocked.
    fun navigation(scope: Scope, url: String): Nav {
        val target = url.toHttpUrlOrNull() ?: return Nav.Block
        val sameOrigin = target.scheme == scope.origin.scheme && target.host.equals(scope.origin.host, true) && target.port == scope.origin.port
        if (sameOrigin) return if (target.encodedPath.startsWith(scope.prefix)) Nav.Allow else Nav.Block
        // The gateway host on another scheme or port is never "external": it is a downgrade attempt.
        if (target.host.equals(scope.origin.host, true)) return Nav.Block
        if (target.scheme == "https" || target.scheme == "http") return Nav.External(url)
        return Nav.Block
    }

    // Subresource interception: only GET/HEAD to the configured origin carries the Access
    // token (via the gateway client); other methods on that origin fail visibly rather than
    // silently going out without the token. Foreign hosts are never intercepted.
    sealed interface Intercept {
        data object PassThrough : Intercept
        data class Fetch(val url: String) : Intercept
        data class Refuse(val reason: String) : Intercept
    }

    fun intercept(scope: Scope, method: String, url: String, hasToken: Boolean): Intercept {
        val target = url.toHttpUrlOrNull() ?: return Intercept.PassThrough
        val sameOrigin = target.scheme == scope.origin.scheme && target.host.equals(scope.origin.host, true) && target.port == scope.origin.port
        if (!sameOrigin) return Intercept.PassThrough
        if (!target.encodedPath.startsWith(scope.prefix)) return Intercept.Refuse("outside the surface")
        if (!hasToken) return Intercept.PassThrough
        return if (method == "GET" || method == "HEAD") Intercept.Fetch(url) else Intercept.Refuse("$method is not available through Cloudflare Access on the phone")
    }
}
