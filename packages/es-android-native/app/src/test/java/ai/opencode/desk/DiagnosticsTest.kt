package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticsTest {
    @Test
    fun keeps_the_last_twenty_and_annotates_the_message_page() {
        val d = Diagnostics(keep = 20)
        repeat(25) { i -> d.record(RequestTiming("GET", "/oc/session/ses_a/message?limit=30", startedAt = i.toLong(), ttfbMs = 10, bodyBytes = 2048, totalMs = 30, status = 200)) }
        assertEquals(20, d.snapshot().size)
        d.annotate("/session/ses_a/message", parseMs = 7, renderMs = 16, compact = false)
        val last = d.snapshot().last()
        assertEquals(7L, last.parseMs); assertEquals(16L, last.renderMs); assertEquals(false, last.compact)
        val line = Diagnostics.line(last)
        assertTrue(line, line.contains("ttfb 10") && line.contains("2KB") && line.contains("parse 7") && line.contains("frame 16") && line.contains("FULL"))
    }

    @Test
    fun failed_requests_show_the_error_class() {
        val d = Diagnostics()
        d.record(RequestTiming("GET", "/es/api/state", startedAt = 1, totalMs = 5000, error = "SocketTimeoutException"))
        assertTrue(Diagnostics.line(d.snapshot().single()).contains("SocketTimeoutException 5000ms"))
    }
}
