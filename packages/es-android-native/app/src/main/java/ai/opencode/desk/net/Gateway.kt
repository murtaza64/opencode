package ai.opencode.desk.net

import android.content.Context
import ai.opencode.desk.Credentials
import ai.opencode.desk.KeyValueWithKeys
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class GatewayError(val code: Int, message: String, val body: String = "") : IOException(message)
class PairingRequired : IOException("Pairing required")

val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

// The paired es gateway (packages/es-desktop/src/server.ts) is the only network boundary.
// Rules it enforces that this class owns: Host must equal the gateway origin, every
// non-GET request carries Origin = gateway origin, writes to the dashboard attention API
// add X-Attention-CSRF, and the es_remote / es_attention_operator cookies ride along.
class Gateway private constructor(private val prefs: android.content.SharedPreferences, val credentials: Credentials, val client: OkHttpClient, val diagnostics: ai.opencode.desk.Diagnostics, private val fixed: String?) {
    constructor(context: Context) : this(build(context), null)
    private constructor(parts: Triple<android.content.SharedPreferences, Credentials, Pair<OkHttpClient, ai.opencode.desk.Diagnostics>>, fixed: String?) :
        this(parts.first, parts.second, parts.third.first, parts.third.second, fixed)

    companion object {
        val JSON = "application/json".toMediaType()
        // The surface proxy forwards only these; the WebView's own cookie/referer never reach the gateway.
        val SAFE_REQUEST_HEADERS = setOf("accept", "accept-language", "if-none-match", "if-modified-since", "last-event-id", "range")

        private fun build(context: Context): Triple<android.content.SharedPreferences, Credentials, Pair<OkHttpClient, ai.opencode.desk.Diagnostics>> {
            val prefs = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)
            // Cloudflare Access service tokens: app-private, encrypted at rest with a Keystore master
            // key. Read on demand; never logged or surfaced after save.
            val secrets = EncryptedSharedPreferences.create(
                context, "gateway-secrets",
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            fun kv(p: android.content.SharedPreferences) = object : KeyValueWithKeys {
                override fun get(key: String) = p.getString(key, null)
                override fun put(key: String, value: String?) { p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
                override fun keys() = p.all.keys.toList()
            }
            // Every credential is scoped to the exact origin it was issued for.
            val credentials = Credentials(kv(prefs), kv(secrets))
            val diagnostics = ai.opencode.desk.Diagnostics()
            val client = OkHttpClient.Builder()
                .cookieJar(CookieStore(credentials))
                .eventListenerFactory(diagnostics.factory)
                // The token is chosen by the request's own origin, so a multi-host fleet never sends one host's secret to another.
                .addInterceptor(Access.TokenInterceptor({ url -> url }, { url -> credentials.token("${url.scheme}://${url.host}:${url.port}") }))
                .followRedirects(false)
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build()
            // Pre-0.1.13 layouts keyed cookies by bare host and kept one global token; attach them
            // to the current origin once so the existing pairing survives the upgrade.
            if (!prefs.getBoolean("credentials.v2", false)) {
                val origin = prefs.getString("origin", "http://127.0.0.1:47120") ?: "http://127.0.0.1:47120"
                origin.toHttpUrlOrNull()?.host?.let { credentials.migrate(origin, it) }
                prefs.edit().putBoolean("credentials.v2", true).apply()
            }
            return Triple(prefs, credentials, client to diagnostics)
        }
    }

    // A view of this gateway bound to one saved origin (multi-host Work Desk): same client,
    // cookies, tokens and diagnostics; only the target differs. Never changes the primary.
    fun at(target: String): Gateway = if (target == origin) this else Gateway(prefs, credentials, client, diagnostics, target.trimEnd('/'))
    val isPrimary get() = fixed == null

    var origin: String
        get() = fixed ?: prefs.getString("origin", "http://127.0.0.1:47120") ?: "http://127.0.0.1:47120"
        set(value) { check(fixed == null) { "origin views are fixed" }; prefs.edit().putString("origin", value.trimEnd('/')).apply() }

    val paired: Boolean get() = credentials.paired(origin)
    val savedOrigins: List<String> get() = credentials.saved()

    val accessToken: AccessToken? get() = credentials.token(origin)
    val hasAccessToken: Boolean get() = accessToken != null

    fun saveAccessToken(token: AccessToken?) = credentials.saveToken(origin, token)

    // Forgetting the current origin leaves every other saved origin paired.
    fun forget() = credentials.forget(origin)

    private fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl {
        val base = origin.toHttpUrlOrNull() ?: throw IOException("Bad gateway URL")
        val builder = base.newBuilder().encodedPath(path)
        query.forEach { (key, value) -> if (value != null) builder.addQueryParameter(key, value) }
        return builder.build()
    }

    private fun Request.Builder.write(path: String) = apply {
        header("Origin", origin)
        if (path.startsWith("/es/api/attention")) header("X-Attention-CSRF", "1")
    }

    suspend fun pair(code: String): Boolean = withContext(Dispatchers.IO) {
        val body = "code=${java.net.URLEncoder.encode(code.trim(), "UTF-8")}"
            .toRequestBody("application/x-www-form-urlencoded".toMediaType())
        client.newCall(Request.Builder().url(url("/__es/pair")).post(body).build()).execute().use { response ->
            Access.check(response)
            // 303 + Set-Cookie is success; the jar captured the cookie.
            (response.code == 303 && paired).also { if (it) credentials.touch(origin) }
        }
    }

    // True when the gateway answers; throws AccessRequired when Access intercepts instead.
    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url("/__es/health")).build()).execute().use { response ->
            Access.check(response)
            response.isSuccessful
        }
    }

    suspend fun get(path: String, query: Map<String, String?> = emptyMap()): String = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(path, query)).get().build()).body
    }

    // Body plus one named response header, for paginated reads that advertise the next cursor.
    suspend fun getWithHeader(path: String, header: String, query: Map<String, String?> = emptyMap()): Pair<String, String?> = withContext(Dispatchers.IO) {
        val reply = execute(Request.Builder().url(url(path, query)).get().build())
        reply.body to reply.headers[header.lowercase()]
    }

    suspend fun post(path: String, body: String, query: Map<String, String?> = emptyMap()): String = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(path, query)).write(path).post(body.toRequestBody(JSON)).build()).body
    }

    suspend fun delete(path: String, query: Map<String, String?> = emptyMap()): String = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(path, query)).write(path).delete().build()).body
    }

    // Full response for a same-origin GET/HEAD the surface WebView asked for; the token and
    // cookies ride along via the client. Callers guard scope and method.
    fun fetch(method: String, url: String, headers: Map<String, String>): okhttp3.Response {
        val builder = Request.Builder().url(url).method(method, null)
        headers.forEach { (name, value) -> if (name.lowercase() in SAFE_REQUEST_HEADERS) builder.header(name, value) }
        return client.newCall(builder.build()).execute()
    }

    // Raw bytes from an absolute same-origin URL (transcript images). Callers guard the origin.
    fun bytes(url: String): ByteArray =
        client.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            Access.check(response)
            if (!response.isSuccessful) throw GatewayError(response.code, "HTTP ${response.code} GET image")
            response.body?.bytes() ?: ByteArray(0)
        }

    private class Reply(val body: String, val headers: Map<String, String>)

    private fun execute(request: Request): Reply =
        client.newCall(request).execute().use { response ->
            Access.check(response)
            val text = response.body?.string().orEmpty()
            if (response.code == 401 && text.contains("Pairing required")) throw PairingRequired()
            if (!response.isSuccessful) throw GatewayError(response.code, "HTTP ${response.code} ${request.method} ${request.url.encodedPath}", text)
            Reply(text, response.headers.names().associateWith { response.header(it).orEmpty() }.mapKeys { it.key.lowercase() })
        }

    // Streams one server-sent-events connection; `onEvent` receives each `data:` payload.
    // Returns when the stream ends (the caller reconnects with backoff).
    fun stream(path: String, query: Map<String, String?> = emptyMap(), onEvent: (String) -> Unit) {
        val request = Request.Builder().url(url(path, query)).header("Accept", "text/event-stream").get().build()
        val call = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build().newCall(request)
        call.execute().use { response ->
            Access.check(response)
            if (response.code == 401) throw PairingRequired()
            if (!response.isSuccessful) throw GatewayError(response.code, "SSE ${response.code}")
            val source = response.body?.source() ?: return
            val data = StringBuilder()
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> { if (data.isNotEmpty()) onEvent(data.toString()); data.clear() }
                    line.startsWith("data:") -> data.append(line.removePrefix("data:").trim())
                }
            }
        }
    }

}
