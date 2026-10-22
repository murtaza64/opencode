package ai.opencode.desk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(store: DeskStore) {
    var origin by rememberSaveable { mutableStateOf(store.gateway.origin) }
    var code by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Desk", style = MaterialTheme.typography.titleLarge)
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
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Text(error!!, color = Ink.Red, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(20.dp))
        Button(
            enabled = !busy && code.isNotBlank() && origin.startsWith("http"),
            modifier = Modifier.fillMaxWidth().testTag("pair"),
            onClick = {
                busy = true; error = null
                scope.launch { error = store.pair(origin.trim(), code); busy = false }
            },
        ) { Text(if (busy) "Pairing…" else "Pair") }
        Spacer(Modifier.height(16.dp))
        Text("USB: adb reverse tcp:47120 tcp:47120. The code is in the gateway's owner-only state file.", style = MaterialTheme.typography.labelSmall)
    }
}
