package ai.opencode.desk

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// Hand-rolled back stack: a list of routes, Back pops. Keeps navigation explicit and
// lets every screen own its Back behaviour (sheets close before the screen pops).
sealed interface Route {
    data object Home : Route
    data class Agent(val key: String) : Route
    data object Chat : Route
    data object Settings : Route
    data object AddHost : Route
    data class Surface(val id: String) : Route
}

class Nav {
    val stack = mutableStateListOf<Route>(Route.Home)
    // Home's selected tab lives here so Back from a detail screen lands on the same tab.
    var tab by mutableStateOf(0)
    // Direction of the last change, read by the screen transition. It cannot be derived from
    // the stack at animation time: after a pop the outgoing route is no longer in the stack.
    var forward by mutableStateOf(true)
        private set
    val current get() = stack.last()

    fun push(route: Route) {
        if (current == route) return
        stack.add(route)
        forward = true
    }

    fun pop(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        forward = false
        return true
    }
}
