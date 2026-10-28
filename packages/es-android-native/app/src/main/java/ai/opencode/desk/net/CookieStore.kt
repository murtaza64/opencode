package ai.opencode.desk.net

import ai.opencode.desk.Credentials
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

// OkHttp cookie jar over Credentials: cookies are stored and served per exact origin
// (scheme://host:port of the request), so two gateways on one host with different ports,
// or the same port on different hosts, never share a cookie. Values are credentials: never
// logged, never shown.
// Cookies are keyed by the exact origin of each request URL, never by a "current" host.
class CookieStore(private val credentials: Credentials) : CookieJar {
    private fun originOf(url: HttpUrl) = "${url.scheme}://${url.host}:${url.port}"

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        cookies.forEach { credentials.saveCookie(originOf(url), Credentials.Cookie(it.name, it.value, it.expiresAt)) }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> =
        credentials.cookies(originOf(url)).map { Cookie.Builder().name(it.name).value(it.value).domain(url.host).path("/").build() }
}
