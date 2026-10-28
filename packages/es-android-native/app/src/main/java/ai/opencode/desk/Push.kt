package ai.opencode.desk

// Pure rules behind the Notifications settings (inbox-push 2b), kept out of the Android
// classes so they are testable on the JVM.
object Push {
    // Flipping Notifications on: what the screen must do.
    enum class Tap { Enable, AskPermission, ExplainDenied }

    fun onNotificationsTap(on: Boolean, granted: Boolean, canAsk: Boolean): Tap = when {
        !on -> Tap.Enable // turning off never prompts
        granted -> Tap.Enable
        canAsk -> Tap.AskPermission
        else -> Tap.ExplainDenied
    }

    // The foreground service runs only when both switches are on and a host is paired.
    fun serviceWanted(notifications: Boolean, stayConnected: Boolean, paired: Boolean) = notifications && stayConnected && paired

    // Reconciler actions post only after the first read since process start (baseline) and
    // only while the user has Notifications on. The ledger is always recorded.
    fun shouldPost(firstReadSinceStart: Boolean, notifications: Boolean) = !firstReadSinceStart && notifications

    // Every dashboard event, including the `connected` hello, is a reason to refetch.
    fun refetchOn(event: String) = true

    // Turning Notifications off also turns Stay connected off; forget/unpair clears both.
    fun afterNotificationsOff(stayConnected: Boolean) = false
}
