package ai.opencode.desk.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ai.opencode.desk.DeskStore
import ai.opencode.desk.net.AccessToken
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(store: DeskStore) {
    var origin by rememberSaveable { mutableStateOf(store.gateway.origin) }
    var code by rememberSaveable { mutableStateOf("") }
    var accessID by rememberSaveable { mutableStateOf("") }
    var accessSecret by rememberSaveable { mutableStateOf("") }
    var showAccess by rememberSaveable { mutableStateOf(store.gateway.hasAccessToken) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Desk", style = MaterialTheme.typography.titleLarge)
            if (store.profileSwitch.visible) Label(" · ${store.profiles.current.name}", color = Ink.Muted)
            Spacer(Modifier.weight(1f))
            ProfileSwitchAction(store)
        }
        Spacer(Modifier.height(4.dp))
        Text("Pair this phone with the gateway running on your Mac.", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(28.dp))
        OutlinedTextField(
            value = origin, onValueChange = { origin = it }, singleLine = true,
            label = { Text("Gateway") }, modifier = Modifier.fillMaxWidth().testTag("origin"),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = code, onValueChange = { code = it }, singleLine = true,
            label = { Text("Pairing code") }, modifier = Modifier.fillMaxWidth().testTag("code"),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
        )
        // Cloudflare Access service token, optional. Values are write-only: a saved token is
        // reported as present, never echoed back into the fields.
        Spacer(Modifier.height(12.dp))
        if (!showAccess) Text("Behind Cloudflare Access? Add a service token", color = Ink.Blue, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.clickable { showAccess = true }.padding(vertical = 4.dp).testTag("access-toggle"))
        else {
            if (store.gateway.hasAccessToken) Text("Access service token saved. Enter a new one to replace it.", style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(
                value = accessID, onValueChange = { accessID = it }, singleLine = true,
                label = { Text("Access client ID") }, modifier = Modifier.fillMaxWidth().testTag("access-id"),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = accessSecret, onValueChange = { accessSecret = it }, singleLine = true,
                label = { Text("Access client secret") }, modifier = Modifier.fillMaxWidth().testTag("access-secret"),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            )
        }
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Text(error!!, color = Ink.Red, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(20.dp))
        val accessPartial = accessID.isBlank() != accessSecret.isBlank()
        Button(
            enabled = !busy && code.isNotBlank() && origin.startsWith("http") && !accessPartial,
            modifier = Modifier.fillMaxWidth().testTag("pair"),
            onClick = {
                busy = true; error = null
                val token = if (accessID.isNotBlank()) AccessToken(accessID.trim(), accessSecret.trim()) else null
                scope.launch {
                    error = store.pair(origin.trim(), code, token)
                    if (error == null) { accessID = ""; accessSecret = "" }
                    busy = false
                }
            },
        ) { Text(if (busy) "Pairing…" else "Pair") }
        if (accessPartial) Text("Enter both the Access client ID and secret, or neither.", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(16.dp))
        Text("USB: adb reverse tcp:47120 tcp:47120. The code is in the gateway's owner-only state file.", style = MaterialTheme.typography.labelSmall)
    }
}
