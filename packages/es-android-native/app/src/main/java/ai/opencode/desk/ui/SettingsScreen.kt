package ai.opencode.desk.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings as SysSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import ai.opencode.desk.DeskStore
import ai.opencode.desk.Hosts
import ai.opencode.desk.Nav
import ai.opencode.desk.Push
import ai.opencode.desk.Settings
import ai.opencode.desk.StayConnectedService

// Notifications settings (inbox-push 2b). POST_NOTIFICATIONS is requested only when the user
// flips the Notifications switch here, never at launch. Stay connected needs Notifications.
@Composable
fun SettingsScreen(store: DeskStore, nav: Nav) {
    val context = LocalContext.current
    var notifications by remember { mutableStateOf(Settings.notifications(context)) }
    var stay by remember { mutableStateOf(Settings.stayConnected(context)) }
    var denied by remember { mutableStateOf(false) }
    val granted = { Build.VERSION.SDK_INT < 33 || NotificationManagerCompat.from(context).areNotificationsEnabled() }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        denied = !ok
        notifications = ok
        Settings.setNotifications(context, ok)
        if (!ok) stay = false
        StayConnectedService.sync(context)
    }
    val host = Hosts.resolve(store.host)?.label ?: store.gateway.origin.removePrefix("https://").removePrefix("http://")
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Label("← back", color = Ink.Blue, modifier = Modifier.clickable { nav.pop() }.padding(4.dp).testTag("back"))
            Text("Notifications", style = MaterialTheme.typography.titleMedium, color = Ink.Text, modifier = Modifier.padding(start = 12.dp))
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Decision alerts", color = Ink.Text)
                Text("A notification when an agent asks you something on $host.", style = MaterialTheme.typography.bodySmall, color = Ink.Dim)
            }
            Switch(checked = notifications, onCheckedChange = { on ->
                when (Push.onNotificationsTap(on, granted(), Build.VERSION.SDK_INT >= 33)) {
                    Push.Tap.Enable -> { notifications = on; denied = false; if (!on) stay = false; Settings.setNotifications(context, on); StayConnectedService.sync(context) }
                    Push.Tap.AskPermission -> ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                    Push.Tap.ExplainDenied -> denied = true
                }
            }, modifier = Modifier.testTag("toggle-notifications"))
        }
        if (denied || (notifications && !granted())) {
            Text("Notifications are off for Desk in Android settings. Turn them on there to receive alerts.", style = MaterialTheme.typography.bodySmall, color = Ink.Amber, modifier = Modifier.padding(bottom = 4.dp).testTag("denied"))
            Label("Open Android settings →", color = Ink.Blue, modifier = Modifier.clickable {
                context.startActivity(Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SysSettings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.padding(4.dp).testTag("open-settings"))
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Stay connected", color = if (notifications) Ink.Text else Ink.Dim)
                Text("Keep the connection to $host open in the background so alerts arrive while Desk is closed. Shows a quiet ongoing notification with Disconnect.", style = MaterialTheme.typography.bodySmall, color = Ink.Dim)
            }
            Switch(checked = stay && notifications, enabled = notifications, onCheckedChange = { on ->
                stay = on; Settings.setStayConnected(context, on); StayConnectedService.sync(context)
            }, modifier = Modifier.testTag("toggle-stay"))
        }
    }
}
