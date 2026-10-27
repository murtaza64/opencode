package ai.opencode.desk.net

import android.content.Context
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
class Gateway(context: Context) {
    private val prefs = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)
    private val jar = CookieStore(prefs)
    // Cloudflare Access service token: app-private, encrypted at rest with a Keystore master
    // key. Read on demand; never logged or surfaced after save.
    private val secrets = EncryptedSharedPreferences.create(
        context, "gateway-secrets",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(jar)
        .addInterceptor(Access.TokenInterceptor({ origin.toHttpUrlOrNull() }, { accessToken }))
        .followRedirects(false)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    var origin: String
        get() = prefs.getString("origin", "http://127.0.0.1:47120") ?: "http://127.0.0.1:47120"
        set(value) { prefs.edit().putString("origin", value.trimEnd('/')).apply() }

    val paired: Boolean get() = jar.has(origin, "es_remote")

    val accessToken: AccessToken?
        get() {
            val id = secrets.getString("access.id", null) ?: return null
            val secret = secrets.getString("access.secret", null) ?: return null
            return AccessToken(id, secret)
        }
    val hasAccessToken: Boolean get() = secrets.contains("access.id")

    fun saveAccessToken(token: AccessToken?) {
        val editor = secrets.edit()
        if (token == null) editor.remove("access.id").remove("access.secret")
        else editor.putString("access.id", token.id).putString("access.secret", token.secret)
        editor.apply()
    }

    // Forgetting the pairing also drops the Access token: both are credentials for this host.
    fun forget() {
        jar.clear()
        saveAccessToken(null)
    }

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
            response.code == 303 && paired
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

    companion object {
        val JSON = "application/json".toMediaType()
    }
}
