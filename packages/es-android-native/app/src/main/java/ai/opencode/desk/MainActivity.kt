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
import ai.opencode.desk.ui.SurfaceScreen

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
                val forward = nav.forward
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
                is Route.Surface -> SurfaceScreen(store, nav, route.id)
            }
        }
    }
}
