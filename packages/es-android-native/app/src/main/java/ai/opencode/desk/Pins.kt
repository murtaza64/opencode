package ai.opencode.desk

import ai.opencode.desk.model.DashSession
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

// A pinned agent is a lane, not a session: (origin, editspace, lane) keeps following the
// lane's current owner through handoffs. Lane-less sessions pin by session id. Pins never
// move to another host or editspace; each origin has its own list.
@Serializable
data class Pin(val editspace: String, val lane: String? = null, val sessionID: String? = null) {
    val key get() = if (lane != null) "$editspace/$lane" else "$editspace#$sessionID"
}

class PinStore(private val store: KeyValue) {
    private val json = ai.opencode.desk.net.json
    private fun key(origin: String) = "pins:${DeskPointers.normalize(origin)}"

    fun list(origin: String): List<Pin> =
        store.get(key(origin))?.let { runCatching { json.decodeFromString(ListSerializer(Pin.serializer()), it) }.getOrNull() }.orEmpty()

    fun toggle(origin: String, pin: Pin): List<Pin> {
        val current = list(origin)
        val next = if (current.any { it.key == pin.key }) current.filter { it.key != pin.key } else current + pin
        store.put(key(origin), if (next.isEmpty()) null else json.encodeToString(ListSerializer(Pin.serializer()), next))
        return next
    }

    fun has(origin: String, pin: Pin) = list(origin).any { it.key == pin.key }
}

// What a pin looks like on Home, resolved from data the regular refresh already holds.
// No network of its own: `agents` and `sessions` come from the last /es/api/state snapshot.
data class PinView(val pin: Pin, val title: String, val status: String, val activity: String, val agentKey: String?, val updatedAt: Long, val origin: String = "")

object Pins {
    fun resolve(pins: List<Pin>, agents: List<Agent>, sessions: Map<String, List<DashSession>>): List<PinView> = pins.map { pin ->
        if (pin.lane != null) {
            val agent = agents.firstOrNull { it.editspace == pin.editspace && it.lane == pin.lane }
            if (agent == null) PinView(pin, pin.lane, "unavailable", "lane not in ${pin.editspace} right now", null, 0)
            else PinView(pin, agent.title, agent.status, agent.activity, agent.key, agent.activityAt)
        } else {
            val agent = agents.firstOrNull { it.editspace == pin.editspace && it.lane.isBlank() && it.session?.id == pin.sessionID }
            val session = agent?.session ?: sessions[pin.editspace].orEmpty().firstOrNull { it.id == pin.sessionID }
            if (session == null) PinView(pin, pin.sessionID.orEmpty(), "unavailable", "session not in ${pin.editspace} right now", null, 0)
            else PinView(pin, session.title, if (session.live == "busy") "busy" else "idle", agent?.activity ?: session.title, agent?.key, session.updated.toLong())
        }
    }
}
