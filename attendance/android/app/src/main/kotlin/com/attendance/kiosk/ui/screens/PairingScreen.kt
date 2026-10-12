package com.attendance.kiosk.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.BuildConfig
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.pairing.PairingCode
import com.attendance.kiosk.core.pairing.ServerUrlResult
import com.attendance.kiosk.core.pairing.ServerUrlValidator
import com.attendance.kiosk.data.KioskRepository
import com.attendance.kiosk.ui.components.KioskPrimaryButton
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** First launch (or after revocation): server URL + one-time pairing code from the dashboard. */
@Composable
fun PairingScreen(repository: KioskRepository, revoked: Boolean) {
    var url by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val colors = KioskTheme.colors

    fun submit() {
        val validUrl = when (val v = ServerUrlValidator.validate(url, BuildConfig.DEBUG)) {
            is ServerUrlResult.Invalid -> { error = v.message; return }
            is ServerUrlResult.Valid -> v.url
        }
        val normalized = PairingCode.normalize(code)
        if (normalized == null) {
            error = "The pairing code has 9 letters and numbers, like K7Q-4MX-29P."
            return
        }
        busy = true
        error = null
        scope.launch {
            val r = withContext(Dispatchers.IO) { repository.pair(validUrl.toString(), normalized) }
            busy = false
            error = when (r) {
                is ApiResult.Ok -> null
                is ApiResult.Http -> r.message ?: "Pairing failed (${r.status})."
                is ApiResult.Network -> "Can't reach the server. Check the address and the internet connection."
            }
        }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(
            Modifier.safeDrawingPadding().padding(Spacing.lg).widthIn(max = 560.dp).fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            Text("Set up this kiosk", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onBackground)
            if (revoked) {
                Text(
                    "This device was unpaired from the restaurant. Ask the owner for a new pairing code.",
                    style = MaterialTheme.typography.bodyLarge, color = colors.onWarningSoft,
                    modifier = Modifier.fillMaxWidth().background(colors.warningSoft).padding(Spacing.md),
                )
            }
            Text(
                "In the dashboard, open Devices → Add kiosk. Enter the server address and the pairing code shown there (valid for 15 minutes).",
                style = MaterialTheme.typography.bodyLarge, color = colors.muted,
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it.trim() },
                label = { Text("Server address") },
                placeholder = { Text("https://attendance.example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.take(14) },
                label = { Text("Pairing code") },
                placeholder = { Text("K7Q-4MX-29P") },
                singleLine = true,
                textStyle = MaterialTheme.typography.headlineSmall,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall) }
            if (busy) {
                CircularProgressIndicator(Modifier.size(40.dp).align(Alignment.CenterHorizontally))
            } else {
                KioskPrimaryButton("Pair this kiosk", { submit() }, modifier = Modifier.fillMaxWidth())
            }
            Text(
                "Only the device token from pairing is stored on this kiosk, encrypted with the Android Keystore.",
                style = MaterialTheme.typography.bodySmall, color = colors.muted,
            )
        }
    }
}
