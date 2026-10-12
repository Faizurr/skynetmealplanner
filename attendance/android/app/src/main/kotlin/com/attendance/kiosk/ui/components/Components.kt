package com.attendance.kiosk.ui.components

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.core.format.DisplayFormat
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.KioskTouchTarget
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing
import kotlinx.coroutines.delay

/** Returns a function that performs a short haptic tick (keyboard-tap strength). */
@Composable
fun rememberHaptic(): () -> Unit {
    val view = LocalView.current
    return remember(view) {
        val tick: () -> Unit = { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }
        tick
    }
}

/** Primary employee-facing button: big, rounded, high contrast. */
@Composable
fun KioskPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    container: Color = MaterialTheme.colorScheme.primary,
    content: Color = MaterialTheme.colorScheme.onPrimary,
    enabled: Boolean = true,
) {
    val haptic = rememberHaptic()
    Button(
        onClick = { haptic(); onClick() },
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = KioskTouchTarget),
        shape = Shapes.pill,
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
        contentPadding = PaddingValues(horizontal = Spacing.xl, vertical = Spacing.md),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(26.dp))
            Spacer(Modifier.width(Spacing.sm))
        }
        Text(text, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
fun KioskSecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true) {
    val haptic = rememberHaptic()
    OutlinedButton(
        onClick = { haptic(); onClick() },
        enabled = enabled,
        modifier = modifier.defaultMinSize(minHeight = KioskTouchTarget),
        shape = Shapes.pill,
        contentPadding = PaddingValues(horizontal = Spacing.xl, vertical = Spacing.md),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(Spacing.sm))
        }
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
fun KioskTextLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, color: Color = KioskTheme.colors.muted) {
    TextButton(onClick = onClick, modifier = modifier.defaultMinSize(minHeight = 48.dp)) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(Spacing.xs))
        }
        Text(text, color = color, style = MaterialTheme.typography.titleSmall)
    }
}

/** Online / offline + queue indicator. */
@Composable
fun StatusPill(online: Boolean, pending: Int, failed: Int, modifier: Modifier = Modifier) {
    val colors = KioskTheme.colors
    val text = DisplayFormat.syncStatus(online, pending, failed)
    Row(
        modifier = modifier
            .clip(Shapes.pill)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = Spacing.sm, vertical = Spacing.xs)
            .semantics { contentDescription = text },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (online) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(colors.online))
        } else {
            Icon(KioskIcons.CloudOff, contentDescription = null, tint = colors.offline, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(Spacing.xs))
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

/** Calls [onTimeout] after [seconds] unless the key changes; exposes the remaining seconds. */
@Composable
fun rememberCountdown(seconds: Int, key: Any?, onTimeout: () -> Unit): Int {
    var remaining by remember(key) { mutableIntStateOf(seconds) }
    val latest by rememberUpdatedState(onTimeout)
    LaunchedEffect(key) {
        remaining = seconds
        while (remaining > 0) {
            delay(1_000)
            remaining--
        }
        latest()
    }
    return remaining
}

/** A centred message layout used by result/failure screens. */
@Composable
fun MessageBlock(title: String, message: String, modifier: Modifier = Modifier, titleColor: Color = MaterialTheme.colorScheme.onBackground) {
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Text(title, style = MaterialTheme.typography.headlineLarge, color = titleColor, textAlign = TextAlign.Center)
        Text(message, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}
