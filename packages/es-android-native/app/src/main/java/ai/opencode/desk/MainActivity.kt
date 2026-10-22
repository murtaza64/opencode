package ai.opencode.desk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.viewmodel.compose.viewModel
import ai.opencode.desk.ui.AgentScreen
import ai.opencode.desk.ui.ChatScreen
import ai.opencode.desk.ui.ConnectScreen
import ai.opencode.desk.ui.DeskTheme
import ai.opencode.desk.ui.HomeScreen
import ai.opencode.desk.ui.Ink

// Hand-rolled back stack: a list of routes, Back pops. Keeps navigation explicit and
// lets every screen own its Back behaviour (sheets close before the screen pops).
sealed interface Route {
    data object Home : Route
    data class Agent(val key: String) : Route
    data object Chat : Route
}

class Nav {
    val stack = mutableStateListOf<Route>(Route.Home)
    // Home's selected tab lives here so Back from a detail screen lands on the same tab.
    var tab by mutableStateOf(0)
    val current get() = stack.last()
    fun push(route: Route) { if (current != route) stack.add(route) }
    fun pop(): Boolean { if (stack.size <= 1) return false; stack.removeAt(stack.lastIndex); return true }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { DeskTheme { App() } }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun App() {
    val store: DeskStore = viewModel()
    val nav = remember { Nav() }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    // testTags surface as resource-ids so headless uiautomator checks can find Compose nodes.
    Box(Modifier.fillMaxSize().background(Ink.Black).semantics { testTagsAsResourceId = true }) {
        if (store.link == Link.Unpaired) {
            ConnectScreen(store)
            return@Box
        }
        AnimatedContent(
            targetState = nav.current,
            transitionSpec = {
                val forward = nav.stack.indexOf(targetState) >= nav.stack.indexOf(initialState)
                val enter = slideInHorizontally { if (forward) it / 3 else -it / 3 } + fadeIn()
                val exit = slideOutHorizontally { if (forward) -it / 3 else it / 3 } + fadeOut()
                enter togetherWith exit
            },
            label = "route",
        ) { route ->
            when (route) {
                Route.Home -> HomeScreen(store, nav)
                is Route.Agent -> AgentScreen(store, nav, route.key)
                Route.Chat -> ChatScreen(store, nav)
            }
        }
    }
}
