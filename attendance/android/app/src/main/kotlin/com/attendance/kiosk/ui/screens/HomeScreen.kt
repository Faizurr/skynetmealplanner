package com.attendance.kiosk.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.format.DisplayFormat
import com.attendance.kiosk.ui.components.KioskIcons
import com.attendance.kiosk.ui.components.KioskTextLink
import com.attendance.kiosk.ui.components.StatusPill
import com.attendance.kiosk.ui.components.rememberHaptic
import com.attendance.kiosk.ui.theme.ActionLabelCompactStyle
import com.attendance.kiosk.ui.theme.ActionLabelStyle
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing
import com.attendance.kiosk.update.UpdateState
import kotlinx.coroutines.delay
import java.time.Instant

data class HomeData(
    val restaurantName: String,
    val branchName: String?,
    val timezone: String?,
    val instructions: String,
    val online: Boolean,
    val pending: Int,
    val failed: Int,
    val pinEnabled: Boolean,
    val update: UpdateState.Available?,
    val appVersion: String,
)

/**
 * Home: restaurant, live clock, two huge action buttons, status and discreet links.
 * The camera is NOT running here; nothing is analysed until a button is tapped.
 */
@Composable
fun HomeScreen(
    data: HomeData,
    onAction: (Action) -> Unit,
    onPin: () -> Unit,
    onManager: () -> Unit,
) {
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = Spacing.lg, vertical = Spacing.md),
    ) {
        val wide = maxWidth >= 600.dp && maxWidth > maxHeight * 0.9f || maxWidth > maxHeight * 1.2f
        val compact = maxHeight < 520.dp
        Column(Modifier.fillMaxSize()) {
            TopRow(data, compact, onManager)
            Spacer(Modifier.height(if (compact) Spacing.xs else Spacing.md))
            ClockBlock(data.timezone, compact)
            if (data.instructions.isNotBlank()) {
                Text(
                    data.instructions,
                    style = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = Spacing.xs),
                )
            }
            Spacer(Modifier.height(if (compact) Spacing.sm else Spacing.lg))
            val gap: Dp = if (compact) Spacing.sm else Spacing.lg
            if (wide) {
                Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    ActionButton(Action.CHECK_IN, compact, Modifier.weight(1f).fillMaxSize(), onAction)
                    ActionButton(Action.CHECK_OUT, compact, Modifier.weight(1f).fillMaxSize(), onAction)
                }
            } else {
                Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(gap)) {
                    ActionButton(Action.CHECK_IN, compact, Modifier.weight(1f).fillMaxWidth(), onAction)
                    ActionButton(Action.CHECK_OUT, compact, Modifier.weight(1f).fillMaxWidth(), onAction)
                }
            }
            Footer(data, compact, onPin)
        }
    }
}

@Composable
private fun TopRow(data: HomeData, compact: Boolean, onManager: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                data.restaurantName,
                style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            data.branchName?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = KioskTheme.colors.muted, maxLines = 1)
            }
        }
        StatusPill(data.online, data.pending, data.failed)
        Spacer(Modifier.width(Spacing.xs))
        ManagerGear(onManager)
    }
}

/** Discreet manager entry: press and hold the gear for about a second. */
@Composable
private fun ManagerGear(onManager: () -> Unit) {
    val haptic = rememberHaptic()
    var hint by remember { mutableStateOf(false) }
    LaunchedEffect(hint) {
        if (hint) {
            delay(2_500)
            hint = false
        }
    }
    Box(contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .semantics {
                    contentDescription = "Manager mode. Press and hold to open."
                    role = Role.Button
                }
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { hint = true },
                        onLongPress = {
                            haptic()
                            onManager()
                        },
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Settings, contentDescription = null, tint = KioskTheme.colors.muted, modifier = Modifier.size(22.dp).alpha(0.6f))
        }
    }
    if (hint) {
        Text("Hold", style = MaterialTheme.typography.labelSmall, color = KioskTheme.colors.muted)
    }
}

@Composable
private fun ClockBlock(timezone: String?, compact: Boolean) {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = Instant.now()
            delay(1_000L - (System.currentTimeMillis() % 1_000L))
        }
    }
    val zone = remember(timezone) { DisplayFormat.zone(timezone) }
    val (digits, ampm) = DisplayFormat.clock(now, zone)
    val date = DisplayFormat.longDate(now, zone)
    if (compact) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(digits, style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
            Text(" $ampm", style = MaterialTheme.typography.titleLarge, color = KioskTheme.colors.muted, modifier = Modifier.padding(bottom = 6.dp))
            Spacer(Modifier.width(Spacing.md))
            Text(date, style = MaterialTheme.typography.titleMedium, color = KioskTheme.colors.muted, modifier = Modifier.padding(bottom = 8.dp))
        }
    } else {
        Column(Modifier.semantics(mergeDescendants = true) {}) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(digits, style = MaterialTheme.typography.displayLarge, color = MaterialTheme.colorScheme.onBackground)
                Text(" $ampm", style = MaterialTheme.typography.headlineMedium, color = KioskTheme.colors.muted, modifier = Modifier.padding(bottom = 12.dp))
            }
            Text(date, style = MaterialTheme.typography.titleLarge, color = KioskTheme.colors.muted)
        }
    }
}

@Composable
private fun ActionButton(action: Action, compact: Boolean, modifier: Modifier, onAction: (Action) -> Unit) {
    val colors = KioskTheme.colors
    val haptic = rememberHaptic()
    val checkIn = action == Action.CHECK_IN
    val container: Color = if (checkIn) colors.checkIn else colors.checkOut
    val content: Color = if (checkIn) colors.onCheckIn else colors.onCheckOut
    val icon: ImageVector = if (checkIn) KioskIcons.CheckIn else KioskIcons.CheckOut
    val label = if (checkIn) "CHECK IN" else "CHECK OUT"
    val sub = if (checkIn) "Starting your shift" else "Finishing your shift"
    Button(
        onClick = {
            haptic()
            onAction(action)
        },
        modifier = modifier.semantics { contentDescription = "$label. $sub." },
        shape = Shapes.action,
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
        elevation = ButtonDefaults.buttonElevation(defaultElevation = 2.dp, pressedElevation = 0.dp),
    ) {
        if (compact) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(40.dp))
                Spacer(Modifier.width(Spacing.md))
                Text(label, style = ActionLabelCompactStyle)
            }
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Box(
                    Modifier.size(88.dp).clip(CircleShape).background(content.copy(alpha = 0.14f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, modifier = Modifier.size(52.dp))
                }
                Spacer(Modifier.height(Spacing.md))
                Text(label, style = ActionLabelStyle, textAlign = TextAlign.Center)
                Text(sub, style = MaterialTheme.typography.titleMedium, color = content.copy(alpha = 0.8f), textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun Footer(data: HomeData, compact: Boolean, onPin: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = if (compact) Spacing.xxs else Spacing.sm)) {
        data.update?.let { u ->
            val colors = KioskTheme.colors
            Text(
                if (u.mandatory) "Required update ${u.release.versionName} available — ask a manager to install it."
                else "Update ${u.release.versionName} available (manager mode).",
                style = MaterialTheme.typography.labelMedium,
                color = if (u.mandatory) colors.onWarningSoft else colors.muted,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(Shapes.small)
                    .background(if (u.mandatory) colors.warningSoft else Color.Transparent)
                    .padding(horizontal = Spacing.sm, vertical = Spacing.xxs),
            )
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (data.pinEnabled) {
                KioskTextLink("Use staff PIN", onPin, icon = KioskIcons.Keypad)
            }
            Spacer(Modifier.weight(1f))
            Text("v${data.appVersion}", style = MaterialTheme.typography.labelSmall, color = KioskTheme.colors.muted.copy(alpha = 0.7f))
        }
    }
}
