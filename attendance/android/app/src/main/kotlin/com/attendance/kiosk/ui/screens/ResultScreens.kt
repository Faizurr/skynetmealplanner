package com.attendance.kiosk.ui.screens

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.flow.FailureKind
import com.attendance.kiosk.core.flow.FlowState
import com.attendance.kiosk.core.format.KioskText
import com.attendance.kiosk.ui.components.KioskIcons
import com.attendance.kiosk.ui.components.KioskPrimaryButton
import com.attendance.kiosk.ui.components.KioskSecondaryButton
import com.attendance.kiosk.ui.components.KioskTextLink
import com.attendance.kiosk.ui.components.MessageBlock
import com.attendance.kiosk.ui.components.rememberCountdown
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing

private const val IDLE_RETURN_SECONDS = 30

@Composable
fun SuccessScreen(state: FlowState.Success, onDone: () -> Unit) {
    val v = state.view
    val colors = KioskTheme.colors
    val accent = if (v.action == Action.CHECK_IN) colors.checkIn else colors.checkOut
    val soft = if (v.action == Action.CHECK_IN) colors.checkInSoft else colors.checkOutSoft
    val remaining = rememberCountdown(v.returnSeconds.coerceIn(2, 30), state.attempt.eventId, onDone)

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDone)
            .semantics { contentDescription = "${v.headline}. ${v.greeting}. Tap anywhere to return." },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.safeDrawingPadding().padding(Spacing.lg).widthIn(max = 720.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            AnimatedCheck(accent, soft)
            Spacer(Modifier.height(Spacing.xs))
            Text(v.greeting, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground, textAlign = TextAlign.Center)
            Text(v.headline, style = MaterialTheme.typography.titleLarge, color = accent, textAlign = TextAlign.Center)
            Text(v.time, style = MaterialTheme.typography.displayMedium, color = MaterialTheme.colorScheme.onBackground)
            Text(v.date, style = MaterialTheme.typography.titleMedium, color = colors.muted)
            v.duration?.let {
                Text("Worked today: $it", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
            }
            if (v.message.isNotBlank()) {
                Text(v.message, style = MaterialTheme.typography.bodyLarge, color = colors.muted, textAlign = TextAlign.Center)
            }
            if (v.pendingReview) {
                Badge("Waiting for a manager to confirm", colors.warningSoft, colors.onWarningSoft)
            }
            if (v.provisional) {
                Badge("Saved on this device — will sync when online", colors.warningSoft, colors.onWarningSoft)
            }
            Spacer(Modifier.height(Spacing.sm))
            Text("Returning home in $remaining… (tap anywhere)", style = MaterialTheme.typography.labelLarge, color = colors.muted)
        }
    }
}

@Composable
private fun Badge(text: String, bg: Color, fg: Color) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = fg,
        textAlign = TextAlign.Center,
        modifier = Modifier.clip(Shapes.pill).background(bg).padding(horizontal = Spacing.md, vertical = Spacing.xs),
    )
}

/** A soft disc that scales in, then a check mark that draws itself. Subtle, under a second. */
@Composable
private fun AnimatedCheck(accent: Color, soft: Color) {
    val scale = remember { Animatable(0.6f) }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        scale.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow))
    }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(durationMillis = 520, delayMillis = 120, easing = FastOutSlowInEasing))
    }
    Box(Modifier.size(140.dp).scale(scale.value).clip(CircleShape).background(soft), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(80.dp)) {
            val w = size.width
            val h = size.height
            val p1 = Offset(w * 0.16f, h * 0.54f)
            val p2 = Offset(w * 0.42f, h * 0.78f)
            val p3 = Offset(w * 0.86f, h * 0.26f)
            val t = progress.value
            val path = Path().apply {
                moveTo(p1.x, p1.y)
                if (t <= 0.4f) {
                    val f = t / 0.4f
                    lineTo(p1.x + (p2.x - p1.x) * f, p1.y + (p2.y - p1.y) * f)
                } else {
                    lineTo(p2.x, p2.y)
                    val f = (t - 0.4f) / 0.6f
                    lineTo(p2.x + (p3.x - p2.x) * f, p2.y + (p3.y - p2.y) * f)
                }
            }
            drawPath(path, accent, style = Stroke(width = 10.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@Composable
fun SubmittingScreen(state: FlowState.Submitting) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
            CircularProgressIndicator(modifier = Modifier.size(72.dp), strokeWidth = 6.dp)
            Text(
                state.employeeName?.let { "One moment, $it…" } ?: "One moment…",
                style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                if (state.attempt.action == Action.CHECK_IN) "Recording your check-in" else "Recording your check-out",
                style = MaterialTheme.typography.titleMedium, color = KioskTheme.colors.muted,
            )
        }
    }
}

/** The requested action is not possible. Explains why; only offers "Back to home". */
@Composable
fun WrongActionScreen(state: FlowState.WrongAction, onHome: () -> Unit) {
    rememberCountdown(IDLE_RETURN_SECONDS, state.attempt.eventId, onHome)
    CenteredPanel {
        WarningIcon()
        MessageBlock(state.title, state.message)
        Spacer(Modifier.height(Spacing.md))
        KioskPrimaryButton("Back to home", onHome, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
fun FailureScreen(state: FlowState.Failure, onRetry: () -> Unit, onPin: () -> Unit, onHome: () -> Unit) {
    val context = LocalContext.current
    rememberCountdown(IDLE_RETURN_SECONDS, state, onHome)
    CenteredPanel {
        WarningIcon()
        MessageBlock(state.title, state.message)
        Spacer(Modifier.height(Spacing.md))
        if (state.kind == FailureKind.CAMERA_PERMISSION) {
            KioskSecondaryButton(
                "Open camera settings",
                {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(intent) }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (state.canRetry) {
            KioskPrimaryButton("Try again", onRetry, icon = Icons.Filled.Refresh, modifier = Modifier.fillMaxWidth())
        }
        if (state.canUsePin) {
            KioskSecondaryButton("Use PIN instead", onPin, icon = KioskIcons.Keypad, modifier = Modifier.fillMaxWidth())
        }
        KioskTextLink(if (state.canRetry) "Cancel" else "Back to home", onHome)
    }
}

@Composable
fun UnknownFaceScreen(state: FlowState.UnknownFace, onRetry: () -> Unit, onPin: () -> Unit, onHome: () -> Unit) {
    rememberCountdown(IDLE_RETURN_SECONDS, state, onHome)
    CenteredPanel {
        WarningIcon()
        MessageBlock("We don't recognise you yet", if (state.canUsePin) KioskText.UNKNOWN_FACE else KioskText.UNKNOWN_FACE_NO_PIN)
        Spacer(Modifier.height(Spacing.md))
        if (state.canUsePin) {
            KioskPrimaryButton("Use staff PIN", onPin, icon = KioskIcons.Keypad, modifier = Modifier.fillMaxWidth())
        }
        KioskSecondaryButton("Try again", onRetry, icon = Icons.Filled.Refresh, modifier = Modifier.fillMaxWidth())
        KioskTextLink("Back to home", onHome)
    }
}

@Composable
private fun WarningIcon() {
    val colors = KioskTheme.colors
    Box(Modifier.size(96.dp).clip(CircleShape).background(colors.warningSoft), contentAlignment = Alignment.Center) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = colors.warning, modifier = Modifier.size(48.dp))
    }
}

@Composable
fun CenteredPanel(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .safeDrawingPadding()
                .padding(Spacing.lg)
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) { content() }
    }
}
