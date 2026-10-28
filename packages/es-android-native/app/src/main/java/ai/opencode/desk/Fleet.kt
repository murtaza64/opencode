package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import ai.opencode.desk.net.GatewayError
import java.time.Instant
import java.time.ZoneId

// Multi-host Work Desk (android-lead#68): one profile aggregates every saved origin. Pure
// rules for the per-host reach row, the aggregated Work Today cost and the row keys.
object Fleet {
    enum class Reach(val label: String) { Ok("reachable"), Network("network"), Auth("auth"), Server("server"), Profile("profile"), Unknown("checking") }

    data class Host(
        val origin: String,
        val reach: Reach = Reach.Unknown,
        // Verified id from GET /__es/host (never a label); "local" means the gateway did not say.
        val id: String? = null,
        val lastSeen: Long = 0L,
        val checkedAt: Long = 0L,
        val error: String? = null,
    ) {
        val label get() = Hosts.glyph(id)?.let { g -> Hosts.Glyph.entries.first { it == g }.id.replaceFirstChar { c -> c.uppercase() } } ?: tag(origin)
    }

    // Short, human form of an origin for keys and labels: host without scheme/port.
    fun tag(origin: String): String = origin.removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore(':').ifBlank { origin }

    // Classify why a host did not answer. Access challenges are auth; pairing lost is profile
    // (the cookie for this profile is gone); HTTP 5xx is server; everything else is network.
    fun classify(error: Throwable): Reach = when {
        error is ai.opencode.desk.net.AccessRequired -> Reach.Auth
        error is ai.opencode.desk.net.PairingRequired -> Reach.Profile
        error is GatewayError && error.code in 500..599 -> Reach.Server
        error is GatewayError && (error.code == 401 || error.code == 403) -> Reach.Auth
        else -> Reach.Network
    }

    // Row keys: the primary origin keeps the bare "<es>/<lane>" key (pins, routes, tests); every
    // other host prefixes its tag so two hosts with an "opencode" editspace never collide.
    fun keyPrefix(origin: String, primary: String): String = if (DeskPointers.normalize(origin) == DeskPointers.normalize(primary)) "" else "${tag(origin)}|"

    data class WorkToday(val total: Double, val perHost: Map<String, Double>, val observedAt: Map<String, Long>, val partial: Boolean, val hosts: Int)

    // Cost of sessions that were updated today (local day), summed per host, with the time the
    // host was last observed. `partial` when any saved host did not answer: the number is a floor.
    fun workToday(sessions: Map<String, List<DashSession>>, hosts: List<Host>, now: Long, zone: ZoneId = ZoneId.systemDefault()): WorkToday {
        val start = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
        val perHost = sessions.mapValues { (_, list) -> list.filter { it.updated.toLong() >= start }.sumOf { it.cost } }
        val observed = hosts.filter { it.lastSeen > 0 }.associate { it.origin to it.lastSeen }
        return WorkToday(perHost.values.sum(), perHost, observed, partial = hosts.any { it.reach != Reach.Ok }, hosts = hosts.size)
    }
}
