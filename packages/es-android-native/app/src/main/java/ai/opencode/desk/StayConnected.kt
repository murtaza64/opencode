package ai.opencode.desk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// "Stay connected" (inbox-push 2b): a specialUse foreground service that keeps the process,
// and with it the one shared DeskStore connection loop (SSE nudges + refresh + reconciler),
// alive while the app is swiped away. It owns no stream of its own. The ongoing notification
// is low importance, names the host, and offers Disconnect. Stops on forget/unpair.
class StayConnectedService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Disconnect from the notification is the user turning Stay connected off.
        if (intent?.action == ACTION_STOP) { Settings.setStayConnected(this, false); stopSelf(); return START_NOT_STICKY }
        val store = DeskApp.store(this)
        if (!Settings.stayConnected(this) || !store.gateway.paired) { stopSelf(); return START_NOT_STICKY }
        ensureChannel()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, ID, notification(store), type)
        // The store's loop already runs on an application-scoped coroutine; make sure it is up.
        if (!store.connected) store.connect()
        return START_STICKY
    }

    private fun notification(store: DeskStore): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, StayConnectedService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val host = Hosts.resolve(store.host)?.label ?: store.gateway.origin.removePrefix("https://").removePrefix("http://")
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Connected to $host")
            .setContentText("Decision alerts arrive while Desk is in the background")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(0, "Disconnect", stop)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Stay connected", NotificationManager.IMPORTANCE_LOW).apply { description = "Shown while Desk keeps its connection open in the background" },
        )
    }

    companion object {
        const val CHANNEL = "stay-connected"
        const val ID = 2
        const val ACTION_STOP = "ai.opencode.desk.STAY_CONNECTED_STOP"

        fun sync(context: Context) {
            val intent = Intent(context, StayConnectedService::class.java)
            if (Push.serviceWanted(Settings.notifications(context), Settings.stayConnected(context), DeskApp.store(context).gateway.paired)) {
                runCatching { androidx.core.content.ContextCompat.startForegroundService(context, intent) }
            } else context.stopService(intent)
        }
    }
}

// Restart the service after boot only if it was on.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Settings.stayConnected(context)) StayConnectedService.sync(context)
    }
}

// Two switches, app-private, per profile instance. Notifications = the user said yes in our
// settings AND the OS permission is granted; Stay connected requires Notifications.
object Settings {
    private fun prefs(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    fun notifications(context: Context) = prefs(context).getBoolean("notifications", false)
    fun setNotifications(context: Context, on: Boolean) { prefs(context).edit().putBoolean("notifications", on).apply(); if (!on) setStayConnected(context, Push.afterNotificationsOff(stayConnected(context))) }
    fun stayConnected(context: Context) = prefs(context).getBoolean("stay", false)
    fun setStayConnected(context: Context, on: Boolean) { prefs(context).edit().putBoolean("stay", on).apply() }
}
