package ai.opencode.desk

import android.content.ComponentName
import android.content.Context
import android.content.pm.CrossProfileApps
import android.graphics.drawable.Drawable
import android.os.UserHandle
import android.os.UserManager

// Platform side of Profiles: lists the other profiles where this package is installed and
// launches our own MainActivity there. All calls are safe on phones without a work profile.
class ProfileBridge(private val context: Context) {
    private val apps = context.getSystemService(CrossProfileApps::class.java)
    private val users = context.getSystemService(UserManager::class.java)

    val current: Profiles.Current get() = Profiles.Current(managed = runCatching { users.isManagedProfile }.getOrDefault(false))

    private fun handles(): List<UserHandle> = runCatching { apps?.targetUserProfiles.orEmpty() }.getOrDefault(emptyList())

    fun targets(): List<Profiles.Target> = handles().map { handle ->
        Profiles.Target(
            label = runCatching { apps!!.getProfileSwitchingLabel(handle).toString() }.getOrDefault("Switch profile"),
            // The target is the opposite kind of profile from the one we are in.
            managed = !current.managed,
        )
    }

    fun icon(): Drawable? = handles().firstOrNull()?.let { runCatching { apps?.getProfileSwitchingIconDrawable(it) }.getOrNull() }

    // Launches Desk in the other profile; Android brings that instance to the front.
    fun switch(): Boolean {
        val handle = handles().firstOrNull() ?: return false
        return runCatching { apps?.startMainActivity(ComponentName(context, MainActivity::class.java), handle); true }.getOrDefault(false)
    }
}
