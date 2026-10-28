package ai.opencode.desk

import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy

// Per-request stage timings (AND-W2, instrumentation only, no behaviour change): DNS,
// connect, TLS, time to first byte, body bytes and ms, plus parse and first-frame timings the
// store adds for message pages. The last 20 are kept in memory for the Diagnostics sheet.
data class RequestTiming(
    val method: String,
    val path: String,
    val startedAt: Long,
    val dnsMs: Long? = null,
    val connectMs: Long? = null,
    val tlsMs: Long? = null,
    val ttfbMs: Long? = null,
    val bodyMs: Long? = null,
    val bodyBytes: Long? = null,
    val totalMs: Long? = null,
    val status: Int? = null,
    val reused: Boolean = false,
    val error: String? = null,
    val parseMs: Long? = null,
    val renderMs: Long? = null,
    val compact: Boolean? = null,
) {
    val label get() = "$method $path"
}

class Diagnostics(private val keep: Int = 20) {
    private val lock = Any()
    private val recent = ArrayDeque<RequestTiming>()
    @Volatile var listeners: ((RequestTiming) -> Unit)? = null

    fun snapshot(): List<RequestTiming> = synchronized(lock) { recent.toList() }

    fun record(timing: RequestTiming) {
        synchronized(lock) {
            recent.removeAll { it.startedAt == timing.startedAt && it.label == timing.label }
            recent.addLast(timing)
            while (recent.size > keep) recent.removeFirst()
        }
        listeners?.invoke(timing)
    }

    // Attach parse / render ms to the most recent timing for a path (the message page).
    fun annotate(pathContains: String, parseMs: Long? = null, renderMs: Long? = null, compact: Boolean? = null) {
        synchronized(lock) {
            val index = recent.indexOfLast { it.path.contains(pathContains) }
            if (index < 0) return
            val t = recent[index]
            recent[index] = t.copy(parseMs = parseMs ?: t.parseMs, renderMs = renderMs ?: t.renderMs, compact = compact ?: t.compact)
        }
    }

    // One listener per call; OkHttp invokes these on its own threads.
    val factory: EventListener.Factory = EventListener.Factory { call -> Listener(call.request()) }

    private inner class Listener(request: Request) : EventListener() {
        private val start = System.nanoTime()
        private var dnsStart = 0L; private var dns: Long? = null
        private var connectStart = 0L; private var connect: Long? = null
        private var tlsStart = 0L; private var tls: Long? = null
        private var ttfb: Long? = null
        private var bodyStart = 0L; private var body: Long? = null; private var bytes: Long? = null
        private var status: Int? = null
        private var reused = false
        private val method = request.method
        private val path = request.url.encodedPath + (request.url.encodedQuery?.let { "?" + it.take(40) } ?: "")
        private val startedAt = System.currentTimeMillis()
        private fun ms(since: Long) = (System.nanoTime() - since) / 1_000_000

        override fun dnsStart(call: Call, domainName: String) { dnsStart = System.nanoTime() }
        override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) { dns = ms(dnsStart) }
        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { connectStart = System.nanoTime() }
        override fun secureConnectStart(call: Call) { tlsStart = System.nanoTime() }
        override fun secureConnectEnd(call: Call, handshake: Handshake?) { tls = ms(tlsStart) }
        override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) { connect = ms(connectStart) }
        override fun connectionAcquired(call: Call, connection: Connection) { if (connectStart == 0L) reused = true }
        override fun responseHeadersEnd(call: Call, response: Response) { ttfb = ms(start); status = response.code }
        override fun responseBodyStart(call: Call) { bodyStart = System.nanoTime() }
        override fun responseBodyEnd(call: Call, byteCount: Long) { body = ms(bodyStart); bytes = byteCount }
        override fun callEnd(call: Call) { record(RequestTiming(method, path, startedAt, dns, connect, tls, ttfb, body, bytes, ms(start), status, reused)) }
        override fun callFailed(call: Call, ioe: IOException) { record(RequestTiming(method, path, startedAt, dns, connect, tls, ttfb, body, bytes, ms(start), status, reused, error = ioe.javaClass.simpleName)) }
    }

    companion object {
        // Rendering for the sheet: one compact line per request.
        fun line(t: RequestTiming): String {
            val stages = listOfNotNull(
                t.dnsMs?.let { "dns $it" }, t.connectMs?.let { "conn $it" }, t.tlsMs?.let { "tls $it" },
                t.ttfbMs?.let { "ttfb $it" }, t.bodyMs?.let { "body $it" }, t.bodyBytes?.let { "${it / 1024}KB" },
                t.parseMs?.let { "parse $it" }, t.renderMs?.let { "frame $it" },
                t.compact?.let { if (it) "compact" else "FULL" },
            ).joinToString(" · ")
            val head = "${t.status ?: t.error ?: "…"} ${t.totalMs ?: "-"}ms${if (t.reused) " (reused)" else ""}"
            return "${t.label}\n  $head · $stages"
        }
    }
}
