package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// inbox-push 2b rules (android-lead#44).
class PushTest {
    @Test
    fun permission_is_asked_only_when_turning_notifications_on_without_a_grant() {
        assertEquals(Push.Tap.AskPermission, Push.onNotificationsTap(on = true, granted = false, canAsk = true))
        assertEquals(Push.Tap.Enable, Push.onNotificationsTap(on = true, granted = true, canAsk = true))
        assertEquals(Push.Tap.Enable, Push.onNotificationsTap(on = false, granted = false, canAsk = true))
        assertEquals(Push.Tap.ExplainDenied, Push.onNotificationsTap(on = true, granted = false, canAsk = false))
    }

    @Test
    fun service_runs_only_when_both_switches_are_on_and_a_host_is_paired() {
        assertTrue(Push.serviceWanted(notifications = true, stayConnected = true, paired = true))
        assertFalse(Push.serviceWanted(notifications = false, stayConnected = true, paired = true))
        assertFalse(Push.serviceWanted(notifications = true, stayConnected = false, paired = true))
        assertFalse(Push.serviceWanted(notifications = true, stayConnected = true, paired = false))
    }

    @Test
    fun first_read_after_process_start_is_a_silent_baseline() {
        assertFalse(Push.shouldPost(firstReadSinceStart = true, notifications = true))
        assertTrue(Push.shouldPost(firstReadSinceStart = false, notifications = true))
        assertFalse(Push.shouldPost(firstReadSinceStart = false, notifications = false))
    }

    @Test
    fun every_dashboard_event_including_connected_triggers_a_refetch() {
        assertTrue(Push.refetchOn("connected"))
        assertTrue(Push.refetchOn("{\"kind\":\"attention\"}"))
    }

    @Test
    fun turning_notifications_off_turns_stay_connected_off() {
        assertFalse(Push.afterNotificationsOff(stayConnected = true))
    }
}
