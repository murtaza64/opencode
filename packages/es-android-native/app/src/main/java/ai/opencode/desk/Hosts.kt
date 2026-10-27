package ai.opencode.desk

import kotlinx.serialization.Serializable

// Host identity for location glyphs (DESK-AND-SIDEBARS §4). The glyph is keyed by the verified
// host id the gateway reports at GET /__es/host, never by display name, provider or status.
// Unknown ids get no glyph.

@Serializable
data class HostLink(val id: String, val label: String = "", val origin: String = "")

@Serializable
data class HostInfo(val id: String = "local", val label: String = "Local", val remote: Boolean = false, val hosts: List<HostLink> = emptyList())

object Hosts {
    enum class Glyph(val id: String) { Laptop("laptop"), Ygnium("ygnium"), Mini("mini"), Excalibur("excalibur"), Wingman("wingman") }

    // Only these verified ids draw; "local" is the laptop the gateway runs on.
    fun glyph(hostID: String?): Glyph? = when (hostID?.lowercase()) {
        "local", "laptop" -> Glyph.Laptop
        "ygnium" -> Glyph.Ygnium
        "mini" -> Glyph.Mini
        "excalibur" -> Glyph.Excalibur
        "wingman" -> Glyph.Wingman
        else -> null
    }

    // Accessible suffix for a row name: "on <Host label>", omitted when nothing is verified.
    fun accessibleSuffix(info: HostInfo?): String? = info?.takeIf { glyph(it.id) != null }?.let { "on ${it.label.ifBlank { it.id }}" }

    // Wingman (cloud workers) is a lane property, not a gateway host: an owner session marked
    // `wingman:` draws the cloud regardless of which host the gateway is.
    fun forLane(owner: String, host: HostInfo?): Glyph? = if (owner.startsWith("wingman:")) Glyph.Wingman else glyph(host?.id)
}
