package com.attendance.kiosk.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageAnalysis
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.attendance.kiosk.camera.CameraIssue
import com.attendance.kiosk.camera.CameraPreview
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.face.Guidance
import com.attendance.kiosk.core.flow.FlowState
import com.attendance.kiosk.core.format.KioskText
import com.attendance.kiosk.ui.components.KioskIcons
import com.attendance.kiosk.ui.components.KioskTextLink
import com.attendance.kiosk.ui.components.rememberHaptic
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing
import java.util.concurrent.Executor

@Composable
fun CameraScreen(
    state: FlowState.Camera,
    online: Boolean,
    pinEnabled: Boolean,
    analyzer: ImageAnalysis.Analyzer,
    executor: Executor,
    onCancel: () -> Unit,
    onPin: () -> Unit,
    onCameraIssue: (CameraIssue) -> Unit,
    onPermissionDenied: () -> Unit,
) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        if (!ok) onPermissionDenied()
    }
    // The permission is requested on the first CHECK IN/OUT, never on the home screen.
    LaunchedEffect(state.attempt.eventId) {
        if (!granted) launcher.launch(Manifest.permission.CAMERA)
    }

    val colors = KioskTheme.colors
    val actionColor = if (state.attempt.action == Action.CHECK_IN) colors.checkIn else colors.checkOut
    val onActionColor = if (state.attempt.action == Action.CHECK_IN) colors.onCheckIn else colors.onCheckOut

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            CameraPreview(analyzer = analyzer, executor = executor, onError = onCameraIssue, modifier = Modifier.fillMaxSize())
        }
        FaceFrameOverlay(state.guidance, actionColor)

        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(Spacing.md)) {
            // Top: the selected action and Cancel.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.clip(Shapes.pill).background(actionColor).padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (state.attempt.action == Action.CHECK_IN) KioskIcons.CheckIn else KioskIcons.CheckOut,
                        contentDescription = null, tint = onActionColor, modifier = Modifier.size(28.dp),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(KioskText.actionInProgress(state.attempt.action), style = MaterialTheme.typography.headlineSmall, color = onActionColor)
                }
                Spacer(Modifier.weight(1f))
                CancelButton(onCancel)
            }
            Spacer(Modifier.weight(1f))
            // Bottom: instructions, liveness prompt, scanning indicator, links.
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(Shapes.card)
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(Spacing.lg),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                val prompt = state.livenessPrompt
                if (prompt != null && state.guidance == Guidance.HOLD_STILL) {
                    Text(
                        KioskText.liveness(prompt),
                        style = MaterialTheme.typography.headlineMedium,
                        color = Color.White,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                } else {
                    Text(
                        KioskText.guidance(state.guidance),
                        style = MaterialTheme.typography.headlineSmall,
                        color = Color.White,
                        fontWeight = if (state.guidance == Guidance.ONE_PERSON_ONLY || state.guidance == Guidance.FACE_CHANGED) FontWeight.Bold else FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                ScanningIndicator(state.agreeingFrames, actionColor)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) colors.online else colors.offline))
                    Spacer(Modifier.width(Spacing.xs))
                    Text(
                        if (online) "Online" else "Offline — attendance will be saved on this device",
                        style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.8f),
                    )
                }
                if (pinEnabled && state.failures > 0) {
                    KioskTextLink("Use PIN instead", onPin, icon = KioskIcons.Keypad, color = Color.White)
                }
            }
        }
    }
}

@Composable
private fun CancelButton(onCancel: () -> Unit) {
    val haptic = rememberHaptic()
    Button(
        onClick = { haptic(); onCancel() },
        shape = Shapes.pill,
        colors = ButtonDefaults.buttonColors(containerColor = Color.White.copy(alpha = 0.92f), contentColor = Color(0xFF1D1B18)),
        modifier = Modifier.height(56.dp),
    ) {
        Icon(Icons.Filled.Close, contentDescription = null)
        Spacer(Modifier.width(Spacing.xs))
        Text("Cancel", style = MaterialTheme.typography.titleMedium)
    }
}

/** Dimmed camera with an oval cut-out; the ring colour reflects the guidance. */
@Composable
private fun FaceFrameOverlay(guidance: Guidance, accent: Color) {
    val colors = KioskTheme.colors
    val ring = when (guidance) {
        Guidance.HOLD_STILL -> accent
        Guidance.ONE_PERSON_ONLY, Guidance.FACE_CHANGED -> colors.warning
        else -> Color.White
    }
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
        initialValue = 0.55f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulseAlpha",
    )
    Canvas(Modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val ovalW = minOf(size.width * 0.72f, size.height * 0.5f)
        val ovalH = ovalW * 1.3f
        val topLeft = Offset((size.width - ovalW) / 2f, (size.height - ovalH) / 2.4f)
        drawRect(colors.cameraScrim.copy(alpha = 0.45f))
        drawOval(Color.Transparent, topLeft = topLeft, size = Size(ovalW, ovalH), blendMode = BlendMode.Clear)
        drawOval(ring.copy(alpha = if (guidance == Guidance.HOLD_STILL) pulse else 0.9f), topLeft = topLeft, size = Size(ovalW, ovalH), style = Stroke(width = 6.dp.toPx()))
    }
}

/** Three dots that fill as consecutive frames agree on the same person. */
@Composable
private fun ScanningIndicator(agreeing: Int, accent: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
        Text("Scanning", style = MaterialTheme.typography.labelLarge, color = Color.White.copy(alpha = 0.85f))
        Spacer(Modifier.width(Spacing.xxs))
        repeat(3) { i ->
            Box(
                Modifier.size(12.dp).clip(CircleShape)
                    .background(if (i < agreeing) accent else Color.White.copy(alpha = 0.3f)),
            )
        }
    }
}
