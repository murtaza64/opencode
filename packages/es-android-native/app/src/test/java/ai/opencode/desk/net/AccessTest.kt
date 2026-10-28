package ai.opencode.desk.net

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessDetectionTest {
    @Test
    fun redirect_to_cloudflareaccess_is_a_challenge() {
        assertTrue(Access.challenged(302, null, "https://murtaza.cloudflareaccess.com/cdn-cgi/access/login/agents.murtaza.earth?kid=abc"))
    }

    @Test
    fun www_authenticate_header_is_a_challenge_on_401_and_403() {
        assertTrue(Access.challenged(401, "Cloudflare-Access", null))
        assertTrue(Access.challenged(403, "cloudflare-access realm=\"x\"", null))
    }

    @Test
    fun plain_401_pairing_required_is_not_a_challenge() {
        assertFalse(Access.challenged(401, null, null))
    }

    @Test
    fun gateway_303_after_pairing_is_not_a_challenge() {
        assertFalse(Access.challenged(303, null, "/"))
        assertFalse(Access.challenged(303, null, "http://127.0.0.1:47120/"))
    }

    @Test
    fun cloudflare_header_on_a_200_is_ignored() {
        assertFalse(Access.challenged(200, "Cloudflare-Access", null))
    }

    @Test
    fun lookalike_host_is_not_a_challenge() {
        assertFalse(Access.challenged(302, null, "https://cloudflareaccess.com.evil.example/login"))
    }

    @Test
    fun check_throws_on_a_real_access_redirect() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login/x").setHeader("WWW-Authenticate", "Cloudflare-Access"))
        server.start()
        val client = OkHttpClient.Builder().followRedirects(false).build()
        try {
            client.newCall(Request.Builder().url(server.url("/__es/health")).build()).execute().use { response ->
                var thrown: Throwable? = null
                try { Access.check(response) } catch (error: AccessRequired) { thrown = error }
                assertEquals("This server is behind Cloudflare Access", thrown?.message)
            }
        } finally {
            server.shutdown()
        }
    }
}

class AccessTokenInterceptorTest {
    private val token = AccessToken("client-id.access", "s3cr3t-value-never-shown")

    private fun client(origin: String?) = OkHttpClient.Builder()
        .addInterceptor(Access.TokenInterceptor({ _ -> origin?.toHttpUrl() }, { _ -> token }))
        .followRedirects(false)
        .build()

    @Test
    fun adds_headers_on_the_configured_origin_including_derived_clients() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("ok"))
        server.enqueue(MockResponse().setBody("ok"))
        server.start()
        try {
            val origin = server.url("/").toString().trimEnd('/')
            val base = client(origin)
            base.newCall(Request.Builder().url(server.url("/__es/health")).build()).execute().close()
            // The SSE path builds its client with newBuilder(); interceptors must survive that.
            base.newBuilder().readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS).build()
                .newCall(Request.Builder().url(server.url("/es/api/notification-events")).build()).execute().close()
            repeat(2) {
                val recorded = server.takeRequest()
                assertEquals("client-id.access", recorded.getHeader(Access.ID_HEADER))
                assertEquals("s3cr3t-value-never-shown", recorded.getHeader(Access.SECRET_HEADER))
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun never_adds_headers_on_a_foreign_host() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("ok"))
        server.start()
        try {
            client("https://agents.example.net").newCall(Request.Builder().url(server.url("/__es/health")).build()).execute().close()
            val recorded = server.takeRequest()
            assertNull(recorded.getHeader(Access.ID_HEADER))
            assertNull(recorded.getHeader(Access.SECRET_HEADER))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun never_adds_headers_when_scheme_differs() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("ok"))
        server.start()
        try {
            // Configured as https on the same host/port; the request goes out over plain http.
            val origin = server.url("/").newBuilder().scheme("https").build().toString().trimEnd('/')
            client(origin).newCall(Request.Builder().url(server.url("/__es/health")).build()).execute().close()
            assertNull(server.takeRequest().getHeader(Access.SECRET_HEADER))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun authorize_is_a_no_op_without_a_token_or_origin() {
        val request = Request.Builder().url("https://agents.example.net/__es/health").build()
        assertNull(Access.authorize(request, "https://agents.example.net".toHttpUrl(), null).header(Access.ID_HEADER))
        assertNull(Access.authorize(request, null, token).header(Access.ID_HEADER))
    }

    @Test
    fun authorize_ignores_host_case_but_not_port() {
        val request = Request.Builder().url("https://AGENTS.example.net/__es/health").build()
        assertEquals("client-id.access", Access.authorize(request, "https://agents.example.net".toHttpUrl(), token).header(Access.ID_HEADER))
        assertNull(Access.authorize(request, "https://agents.example.net:8443".toHttpUrl(), token).header(Access.ID_HEADER))
    }
}

class AccessTokenSecrecyTest {
    @Test
    fun to_string_hides_the_secret_and_most_of_the_id() {
        val text = AccessToken("abcdef0123456789.access", "super-secret-value").toString()
        assertFalse(text.contains("super-secret-value"))
        assertFalse(text.contains("0123456789"))
        assertEquals("AccessToken(id=abcdef…)", text)
    }

    @Test
    fun access_required_message_carries_no_request_detail() {
        assertEquals("This server is behind Cloudflare Access", AccessRequired().message)
    }
}
