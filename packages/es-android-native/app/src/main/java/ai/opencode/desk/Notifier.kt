package ai.opencode.desk

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

// Platform side of the reconciler (inbox-push slice 2a): channels "Decisions" and
// "Permissions" (OS-level per-type mute/DND), one notification per tag replaced in place,
// private visibility with a public "Decision needed" version, a tap deep link carrying ids +
// revision only. POST_NOTIFICATIONS is declared but never requested here: nothing posts until
// the human has granted it elsewhere (slice 2b opt-in).
class Notifier(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    val allowed: Boolean
        get() = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    init {
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(DECISIONS, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply { description = "Decisions and blockers waiting on you" })
            manager.createNotificationChannel(NotificationChannel(PERMISSIONS, "Permissions", NotificationManager.IMPORTANCE_HIGH).apply { description = "Agents asking for permission or an answer" })
        }
    }

    fun apply(actions: List<Reconciler.Action>) {
        if (!allowed) return
        actions.forEach { action ->
            when (action) {
                is Reconciler.Action.Cancel -> manager.cancel(action.tag, ID)
                is Reconciler.Action.Post -> post(action.tag, action.item)
                is Reconciler.Action.Update -> post(action.tag, action.item)
            }
        }
    }

    private fun post(tag: String, item: Reconciler.Item) {
        val target = Reconciler.target(tag) ?: return
        val channel = if (item.kind == "permission" || item.kind == "question") PERMISSIONS else DECISIONS
        val heading = when (item.kind) {
            "decision" -> "Decision needed"
            "delivery-blocked" -> "Answer not delivered"
            "stalled" -> "Still waiting on the agent"
            "permission" -> "Permission requested"
            "question" -> "Question from an agent"
            else -> "Needs you"
        }
        val open = Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            putExtra("desk.origin", target.origin); putExtra("desk.editspace", target.editspace)
            putExtra("desk.kind", target.kind); putExtra("desk.id", target.id); putExtra("desk.revision", item.revision)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val public = NotificationCompat.Builder(context, channel).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(heading).setContentIntent(pending).build()
        val notification: Notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(heading)
            .setContentText(item.title)
            .setSubText(item.editspace)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .build()
        manager.notify(tag, ID, notification)
    }

    companion object {
        const val DECISIONS = "decisions"
        const val PERMISSIONS = "permissions"
        const val ID = 1
        const val ACTION_OPEN = "ai.opencode.desk.OPEN"
    }
}
