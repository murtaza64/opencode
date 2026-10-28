package ai.opencode.desk

import kotlinx.serialization.Serializable

// Host identity for location glyphs (DESK-AND-SIDEBARS §4). The glyph is keyed by the verified
// host id the gateway reports at GET /__es/host, never by display name, provider or status.
// Unknown ids get no glyph.

@Serializable
data class HostLink(val id: String, val label: String = "", val origin: String = "")

@Serializable
data class HostInfo(val id: String = "local", val label: String = "Local", val remote: Boolean = false, val hosts: List<HostLink> = emptyList(), val self: String? = null)

object Hosts {
    enum class Glyph(val id: String) { Laptop("laptop"), Ygnium("ygnium"), Mini("mini"), Excalibur("excalibur"), Wingman("wingman") }

    // Only these verified ids draw. "local" is NOT a host: on a gateway it means "this gateway's
    // own machine", whose identity must come from `resolve()`; a bare "local" draws nothing.
    fun glyph(hostID: String?): Glyph? = when (hostID?.lowercase()) {
        "laptop" -> Glyph.Laptop
        "ygnium" -> Glyph.Ygnium
        "mini" -> Glyph.Mini
        "excalibur" -> Glyph.Excalibur
        "wingman" -> Glyph.Wingman
        else -> null
    }

    // The gateway's own verified identity. /__es/host answers {id:"local"} on every gateway, so
    // the machine is identified only by a verified id: the federation registry's `self`
    // (learned from delivery/wake-event host fields) or a known id in `id`. Labels never
    // decide. Unknown → null and the glyph is omitted.
    fun resolve(info: HostInfo?): HostInfo? {
        if (info == null) return null
        val self = info.self?.takeIf { glyph(it) != null }
        if (self != null) return info.copy(id = self)
        return info.takeIf { glyph(it.id) != null }
    }

    // Accessible suffix for a row name: "on <Host label>", omitted when nothing is verified.
    fun accessibleSuffix(info: HostInfo?): String? = resolve(info)?.let { "on ${it.label.ifBlank { it.id }}" }

    // Wingman (cloud workers) is a lane property, not a gateway host: an owner session marked
    // `wingman:` draws the cloud regardless of which host the gateway is.
    fun forLane(owner: String, host: HostInfo?): Glyph? = if (owner.startsWith("wingman:")) Glyph.Wingman else glyph(resolve(host)?.id)
}
