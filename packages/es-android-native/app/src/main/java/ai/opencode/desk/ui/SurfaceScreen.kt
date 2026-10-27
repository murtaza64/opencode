package ai.opencode.desk.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Nav
import ai.opencode.desk.SurfacePolicy
import java.io.ByteArrayInputStream

// A published surface in a sandboxed WebView: scripts on (surfaces need them), no file or
// content access, no JS interface, no downloads. Navigation stays inside the surface's own
// capability prefix; other http(s) links open in the system browser only after confirmation.
// On a Cloudflare Access host the WebView cannot carry the service token itself, so GET/HEAD
// subresources are fetched through the authenticated gateway client; other methods fail visibly.
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SurfaceScreen(store: DeskStore, nav: Nav, id: String) {
    val surface = store.surfaces.firstOrNull { it.id == id }
    var scope by remember { mutableStateOf<SurfacePolicy.Scope?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var external by remember { mutableStateOf<String?>(null) }
    var canGoBack by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val context = LocalContext.current

    LaunchedEffect(id) {
        runCatching { store.api.surfaceAddress(id) }.fold(
            onSuccess = { address -> scope = SurfacePolicy.scope(store.gateway.origin, address.src) ?: run { error = "The gateway returned an unexpected surface address"; null } },
            onFailure = { error = it.message ?: "Could not open the surface" },
        )
    }
    // Back walks the surface's own history first, then closes the screen.
    BackHandler { if (canGoBack) webView?.goBack() else nav.pop() }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        TopBar(surface?.title ?: id, onBack = { nav.pop() }) {
            Label(listOfNotNull(surface?.owner, surface?.purpose, surface?.health?.state, surface?.let { "rev ${it.revision}" }).joinToString(" · "))
        }
        notice?.let { Text(it, color = Ink.Amber, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).testTag("surface-notice")) }
        when {
            error != null -> Text(error!!, color = Ink.Red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp).testTag("surface-error"))
            scope == null -> Text("Opening…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(20.dp))
            else -> Box(Modifier.fillMaxSize().testTag("surface")) {
                val current = scope!!
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            settings.setSupportMultipleWindows(false)
                            settings.javaScriptCanOpenWindowsAutomatically = false
                            settings.setGeolocationEnabled(false)
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            settings.builtInZoomControls = true
                            settings.displayZoomControls = false
                            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            setBackgroundColor(android.graphics.Color.BLACK)
                            setDownloadListener { _, _, _, _, _ -> notice = "Downloads are not available on the phone yet" }
                            webViewClient = object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                                    when (val decision = SurfacePolicy.navigation(current, request.url.toString())) {
                                        SurfacePolicy.Nav.Allow -> false
                                        is SurfacePolicy.Nav.External -> { external = decision.url; true }
                                        SurfacePolicy.Nav.Block -> { notice = "Blocked: ${request.url.host ?: request.url}"; true }
                                    }

                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                                    when (val plan = SurfacePolicy.intercept(current, request.method, request.url.toString(), store.gateway.hasAccessToken)) {
                                        SurfacePolicy.Intercept.PassThrough -> null
                                        is SurfacePolicy.Intercept.Refuse -> WebResourceResponse("text/plain", "utf-8", 405, "Refused", mapOf("X-Desk" to plan.reason), ByteArrayInputStream(plan.reason.toByteArray()))
                                        is SurfacePolicy.Intercept.Fetch -> runCatching {
                                            val response = store.gateway.fetch(request.method, plan.url, request.requestHeaders)
                                            val type = response.header("Content-Type") ?: "application/octet-stream"
                                            val mime = type.substringBefore(';').trim()
                                            val charset = type.substringAfter("charset=", "").substringBefore(';').trim().ifBlank { null }
                                            val headers = response.headers.names().filter { it.lowercase() !in setOf("content-encoding", "transfer-encoding", "set-cookie") }.associateWith { response.header(it).orEmpty() }
                                            val body = response.body?.bytes() ?: ByteArray(0)
                                            response.close()
                                            WebResourceResponse(mime, charset, response.code, response.message.ifBlank { "OK" }, headers, ByteArrayInputStream(body))
                                        }.getOrElse { WebResourceResponse("text/plain", "utf-8", 502, "Gateway", emptyMap(), ByteArrayInputStream("Surface unreachable: ${it.message}".toByteArray())) }
                                    }

                                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { canGoBack = view.canGoBack() }
                            }
                            loadUrl(SurfacePolicy.entry(current))
                            webView = this
                        }
                    },
                )
            }
        }
    }
    external?.let { url ->
        AlertDialog(
            onDismissRequest = { external = null },
            title = { Text("Open in browser?") },
            text = { Text(url, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = { TextButton(onClick = { external = null; runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }.onFailure { notice = "No browser available" } }) { Text("Open") } },
            dismissButton = { TextButton(onClick = { external = null }) { Text("Stay") } },
            containerColor = Ink.Panel,
        )
    }
}
