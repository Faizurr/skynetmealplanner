package com.attendance.kiosk.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.flow.FlowState
import com.attendance.kiosk.core.format.KioskText
import com.attendance.kiosk.ui.components.KioskIcons
import com.attendance.kiosk.ui.components.KioskPrimaryButton
import com.attendance.kiosk.ui.components.KioskTextLink
import com.attendance.kiosk.ui.components.rememberCountdown
import com.attendance.kiosk.ui.components.rememberHaptic
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing

/** Staff ID + PIN fallback. Asks for the action first when opened from the home screen. */
@Composable
fun PinScreen(
    state: FlowState.PinEntry,
    online: Boolean,
    onChooseAction: (Action) -> Unit,
    onSubmit: (String, String) -> Unit,
    onCancel: () -> Unit,
) {
    // Leave the keypad if nobody finishes within a minute (privacy on a shared kiosk).
    rememberCountdown(60, state, onCancel)
    val colors = KioskTheme.colors
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.safeDrawingPadding().padding(Spacing.lg).widthIn(max = 560.dp).fillMaxWidth().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            val action = state.action
            if (action == null) {
                Text("Use your staff PIN", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onBackground)
                Text("What would you like to do?", style = MaterialTheme.typography.titleMedium, color = colors.muted)
                KioskPrimaryButton(
                    "CHECK IN", { onChooseAction(Action.CHECK_IN) }, icon = KioskIcons.CheckIn,
                    container = colors.checkIn, content = colors.onCheckIn, modifier = Modifier.fillMaxWidth().height(88.dp),
                )
                KioskPrimaryButton(
                    "CHECK OUT", { onChooseAction(Action.CHECK_OUT) }, icon = KioskIcons.CheckOut,
                    container = colors.checkOut, content = colors.onCheckOut, modifier = Modifier.fillMaxWidth().height(88.dp),
                )
                KioskTextLink("Cancel", onCancel)
            } else {
                PinForm(action, state.error, online, onSubmit, onCancel)
            }
        }
    }
}

@Composable
private fun PinForm(action: Action, error: String?, online: Boolean, onSubmit: (String, String) -> Unit, onCancel: () -> Unit) {
    val colors = KioskTheme.colors
    var staffId by rememberSaveable { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    val staffFocus = remember { FocusRequester() }
    val accent = if (action == Action.CHECK_IN) colors.checkIn else colors.checkOut

    Text(
        KioskText.actionInProgress(action),
        style = MaterialTheme.typography.headlineMedium,
        color = accent,
    )
    Text("Enter your staff ID and PIN", style = MaterialTheme.typography.titleMedium, color = colors.muted)
    OutlinedTextField(
        value = staffId,
        onValueChange = { staffId = it.take(32) },
        label = { Text("Staff ID") },
        singleLine = true,
        textStyle = MaterialTheme.typography.headlineSmall,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        modifier = Modifier.fillMaxWidth().focusRequester(staffFocus),
    )
    // PIN dots
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.semantics { contentDescription = "${pin.length} digits entered" }) {
        repeat(maxOf(4, pin.length)) { i ->
            Box(
                Modifier.size(18.dp).clip(CircleShape)
                    .background(if (i < pin.length) MaterialTheme.colorScheme.onBackground else colors.hairline),
            )
        }
    }
    if (error != null) {
        Text(error, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
    }
    if (!online) {
        Text("The kiosk is offline. PIN check-in needs an internet connection.", style = MaterialTheme.typography.bodyMedium, color = colors.offline)
    }
    Keypad(
        onDigit = { d -> if (pin.length < 8) pin += d },
        onBackspace = { pin = pin.dropLast(1) },
        onClear = { pin = "" },
    )
    KioskPrimaryButton(
        "Confirm",
        {
            focus.clearFocus()
            onSubmit(staffId, pin)
            pin = ""
        },
        container = accent,
        content = if (action == Action.CHECK_IN) colors.onCheckIn else colors.onCheckOut,
        enabled = staffId.isNotBlank() && pin.length >= 4,
        modifier = Modifier.fillMaxWidth(),
    )
    KioskTextLink("Cancel", onCancel)
}

@Composable
private fun Keypad(onDigit: (String) -> Unit, onBackspace: () -> Unit, onClear: () -> Unit) {
    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫")
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val keyWidth = (maxWidth - Spacing.sm * 2) / 3
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            keys.chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    row.forEach { k ->
                        KeyButton(
                            k,
                            Modifier.size(width = keyWidth, height = 72.dp),
                        ) {
                            when (k) {
                                "⌫" -> onBackspace()
                                "C" -> onClear()
                                else -> onDigit(k)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun KeyButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    val haptic = rememberHaptic()
    val description = when (label) {
        "⌫" -> "Delete last digit"
        "C" -> "Clear PIN"
        else -> label
    }
    Button(
        onClick = { haptic(); onClick() },
        modifier = modifier.semantics { contentDescription = description },
        shape = Shapes.card,
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.onBackground,
        ),
    ) {
        if (label == "⌫") {
            Icon(KioskIcons.Backspace, contentDescription = null, modifier = Modifier.size(30.dp))
        } else {
            Text(label, style = MaterialTheme.typography.headlineMedium)
        }
    }
}
