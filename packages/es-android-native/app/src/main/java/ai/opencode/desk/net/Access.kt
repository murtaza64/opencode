package ai.opencode.desk.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

// The gateway host may sit behind Cloudflare Access. Access answers every unauthenticated
// request with a redirect to the team's cloudflareaccess.com login (or a 401/403 carrying
// `WWW-Authenticate: Cloudflare-Access`). This file has no Android dependencies so the
// detection and header rules are unit-testable on the JVM.

class AccessRequired : IOException("This server is behind Cloudflare Access")

// A service token. toString never includes the secret so it cannot leak through logs.
class AccessToken(val id: String, val secret: String) {
    override fun toString() = "AccessToken(id=${id.take(6)}…)"
}

object Access {
    const val ID_HEADER = "CF-Access-Client-Id"
    const val SECRET_HEADER = "CF-Access-Client-Secret"

    fun challenged(code: Int, wwwAuthenticate: String?, location: String?): Boolean {
        if (code !in 300..399 && code != 401 && code != 403) return false
        if (wwwAuthenticate?.contains("Cloudflare-Access", ignoreCase = true) == true) return true
        val host = location?.toHttpUrlOrNull()?.host ?: return false
        return host.endsWith(".cloudflareaccess.com", ignoreCase = true)
    }

    fun check(response: Response) {
        if (challenged(response.code, response.header("WWW-Authenticate"), response.header("Location"))) throw AccessRequired()
    }

    // Adds the service-token headers only to requests for the configured origin: same
    // scheme, host and port. A redirect or a mistyped http:// origin never carries the secret.
    fun authorize(request: Request, origin: HttpUrl?, token: AccessToken?): Request {
        if (origin == null || token == null) return request
        val url = request.url
        if (url.scheme != origin.scheme || !url.host.equals(origin.host, ignoreCase = true) || url.port != origin.port) return request
        return request.newBuilder().header(ID_HEADER, token.id).header(SECRET_HEADER, token.secret).build()
    }

    // Reads origin and token at request time so a change on the Connect screen applies to the
    // next call without rebuilding the client (the SSE client is derived via newBuilder()).
    class TokenInterceptor(private val origin: () -> HttpUrl?, private val token: () -> AccessToken?) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response = chain.proceed(authorize(chain.request(), origin(), token()))
    }
}
