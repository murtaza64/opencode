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
import androidx.compose.foundation.layout.width
import androidx.compose.ui.unit.dp
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
import ai.opencode.desk.ui.LocalReducedMotion
import androidx.compose.runtime.CompositionLocalProvider
import ai.opencode.desk.ui.SurfaceScreen

class MainActivity : ComponentActivity() {
    override fun onResume() {
        super.onResume()
        (androidx.lifecycle.ViewModelProvider(this)[DeskStore::class.java]).refreshProfiles()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val reduced = android.provider.Settings.Global.getFloat(contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        // Debug-only capture aids (ignored in release): force RTL and a narrow column, open a given agent.
        val debug = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val rtl = debug && intent.getBooleanExtra("desk.rtl", false)
        val width = if (debug) intent.getIntExtra("desk.width", 0) else 0
        val openAgent = if (debug) intent.getStringExtra("desk.agent") else null
        setContent {
            CompositionLocalProvider(LocalReducedMotion provides reduced, androidx.compose.ui.platform.LocalLayoutDirection provides if (rtl) androidx.compose.ui.unit.LayoutDirection.Rtl else androidx.compose.ui.unit.LayoutDirection.Ltr) {
                DeskTheme {
                    if (width > 0) Box(Modifier.fillMaxSize().background(Ink.Black), contentAlignment = androidx.compose.ui.Alignment.TopCenter) { Box(Modifier.width(width.dp).fillMaxSize()) { App(openAgent) } }
                    else App(openAgent)
                }
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun App(openAgent: String? = null) {
    val store: DeskStore = viewModel()
    val nav = remember { Nav() }
    androidx.compose.runtime.LaunchedEffect(openAgent, store.agents.size) {
        if (openAgent != null && nav.current == Route.Home && store.agents.any { it.key == openAgent }) nav.push(Route.Agent(openAgent))
    }
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
