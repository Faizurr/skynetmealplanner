package com.attendance.kiosk.ui.manager

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.attendance.kiosk.BuildConfig
import com.attendance.kiosk.camera.CameraPreview
import com.attendance.kiosk.core.api.ConsentMethod
import com.attendance.kiosk.core.api.KioskConfig
import com.attendance.kiosk.core.api.ManagerEmployee
import com.attendance.kiosk.core.format.DisplayFormat
import com.attendance.kiosk.core.queue.QueueRecord
import com.attendance.kiosk.data.Credentials
import com.attendance.kiosk.face.EngineStatus
import com.attendance.kiosk.ui.components.KioskPrimaryButton
import com.attendance.kiosk.ui.components.KioskSecondaryButton
import com.attendance.kiosk.ui.components.KioskTextLink
import com.attendance.kiosk.ui.theme.KioskTheme
import com.attendance.kiosk.ui.theme.Shapes
import com.attendance.kiosk.ui.theme.Spacing
import com.attendance.kiosk.update.UpdateState
import java.time.Instant
import java.util.concurrent.Executor

/** Everything manager screens need from outside the ViewModel. */
class ManagerEnv(
    val config: KioskConfig?,
    val credentials: Credentials?,
    val online: Boolean,
    val pendingCount: Int,
    val failedCount: Int,
    val lastSyncMs: Long,
    val lastError: String?,
    val engineStatus: EngineStatus,
    val soundOverride: Boolean?,
    val executor: Executor,
    val isLocked: () -> Boolean,
    val startLock: () -> Unit,
    val stopLock: () -> Unit,
)

@Composable
fun ManagerRoot(vm: ManagerViewModel, env: ManagerEnv) {
    val ui by vm.ui.collectAsState()
    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .pointerInput(Unit) {
                // Any touch keeps the manager session alive (inactivity timeout).
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent(PointerEventPass.Initial)
                        vm.touch()
                    }
                }
            },
    ) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            ManagerTopBar(ui, onBack = vm::back, onExit = vm::close)
            HorizontalDivider(color = KioskTheme.colors.hairline)
            Box(Modifier.fillMaxSize()) {
                when (val s = ui.screen) {
                    ManagerScreen.Login -> LoginContent(ui, vm)
                    ManagerScreen.Menu -> MenuContent(ui, vm, env)
                    ManagerScreen.Employees -> EmployeesContent(ui, vm)
                    is ManagerScreen.Privacy -> PrivacyContent(s.employee, env.config, vm)
                    is ManagerScreen.Consent -> ConsentContent(s.employee, ui, vm)
                    is ManagerScreen.Capture -> CaptureContent(s, ui, vm, env)
                    is ManagerScreen.Photo -> PhotoContent(s, ui, vm, env)
                    is ManagerScreen.Confirm -> ConfirmContent(s.employee, ui, vm)
                    is ManagerScreen.Test -> TestContent(s, ui, vm, env)
                    ManagerScreen.Queue -> QueueContent(ui, vm, env)
                    ManagerScreen.DeviceInfo -> DeviceInfoContent(vm, env)
                    ManagerScreen.CameraTest -> CameraTestContent(ui, vm, env)
                    ManagerScreen.Updates -> UpdatesContent(vm)
                    ManagerScreen.Settings -> SettingsContent(vm, env)
                }
            }
        }
    }
}

@Composable
private fun ManagerTopBar(ui: ManagerUi, onBack: () -> Unit, onExit: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.xs, vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.size(56.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
        }
        Column(Modifier.weight(1f)) {
            Text("Manager mode", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
            ui.managerName?.let {
                val mins = ui.remainingSeconds / 60
                val secs = ui.remainingSeconds % 60
                Text(
                    "$it · ends in $mins:${secs.toString().padStart(2, '0')} without activity",
                    style = MaterialTheme.typography.bodySmall, color = KioskTheme.colors.muted,
                )
            }
        }
        TextButton(onClick = onExit, modifier = Modifier.height(56.dp)) {
            Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null)
            Spacer(Modifier.width(Spacing.xs))
            Text("Exit")
        }
    }
}

@Composable
private fun Page(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 720.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) { content() }
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error != null) {
        Text(
            error,
            color = KioskTheme.colors.onWarningSoft,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.fillMaxWidth().clip(Shapes.small).background(KioskTheme.colors.warningSoft).padding(Spacing.md),
        )
    }
}

@Composable
private fun Busy(busy: Boolean) {
    if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
}

// --- Login ----------------------------------------------------------------------------------

@Composable
private fun LoginContent(ui: ManagerUi, vm: ManagerViewModel) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Page {
        Text("Sign in", style = MaterialTheme.typography.headlineMedium)
        Text("Owner or manager account. You'll be signed out after 15 minutes, or sooner when idle.", color = KioskTheme.colors.muted)
        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )
        ErrorText(ui.error)
        Busy(ui.busy)
        KioskPrimaryButton("Sign in", { vm.login(email, password); password = "" }, enabled = !ui.busy, modifier = Modifier.fillMaxWidth())
    }
}

// --- Menu -------------------------------------------------------------------------------------

@Composable
private fun MenuContent(ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    var confirmUnpair by remember { mutableStateOf(false) }
    Page {
        Text("What would you like to do?", style = MaterialTheme.typography.headlineSmall)
        MenuItem(Icons.Filled.Face, "Enroll or re-enroll an employee", "Register a face for check-in") { vm.go(ManagerScreen.Employees) }
        MenuItem(Icons.AutoMirrored.Filled.List, "Offline queue", "${env.pendingCount} waiting · ${env.failedCount} failed") { vm.go(ManagerScreen.Queue) }
        MenuItem(Icons.Filled.Build, "Device info", "Server, versions, models, camera test") { vm.go(ManagerScreen.DeviceInfo) }
        MenuItem(Icons.Filled.Refresh, "Check for updates", "Current version ${BuildConfig.VERSION_NAME}") { vm.go(ManagerScreen.Updates) }
        MenuItem(Icons.Filled.Settings, "Settings", "Kiosk lock, sound") { vm.go(ManagerScreen.Settings) }
        MenuItem(Icons.Filled.Warning, "Unpair this device", "Removes the device token and local data") { confirmUnpair = true }
        ErrorText(ui.error)
    }
    if (confirmUnpair) {
        val pending = env.pendingCount
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this kiosk?") },
            text = {
                Text(
                    (if (pending > 0) "$pending attendance record(s) saved offline have NOT been synced and will be lost. " else "") +
                        "The kiosk will need a new pairing code from the dashboard.",
                )
            },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.unpair() }) { Text("Unpair", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun MenuItem(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clip(Shapes.card).clickable(role = Role.Button, onClick = onClick),
        shape = Shapes.card,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(Modifier.padding(Spacing.lg), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(32.dp))
            Spacer(Modifier.width(Spacing.md))
            Column {
                Text(title, style = MaterialTheme.typography.titleLarge)
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = KioskTheme.colors.muted)
            }
        }
    }
}

// --- Enrollment -------------------------------------------------------------------------------

@Composable
private fun EmployeesContent(ui: ManagerUi, vm: ManagerViewModel) {
    val q = ui.query.trim().lowercase()
    val list = ui.employees.filter {
        q.isEmpty() || it.fullName.lowercase().contains(q) || it.staffId.lowercase().contains(q) || (it.preferredName?.lowercase()?.contains(q) == true)
    }
    Column(Modifier.fillMaxSize().padding(horizontal = Spacing.lg)) {
        Spacer(Modifier.height(Spacing.md))
        OutlinedTextField(
            value = ui.query, onValueChange = vm::setQuery, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            label = { Text("Search by name or staff ID") },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(Spacing.sm))
        Busy(ui.busy)
        ErrorText(ui.error)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(Spacing.xs), modifier = Modifier.fillMaxSize()) {
            items(list, key = { it.id }) { e ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(Shapes.small)
                        .background(MaterialTheme.colorScheme.surface)
                        .clickable(role = Role.Button) { vm.startEnrollment(e) }
                        .padding(Spacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(e.fullName, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(e.staffId, e.jobTitle).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = KioskTheme.colors.muted)
                    }
                    EnrollmentChip(e.enrollmentStatus)
                }
            }
            if (list.isEmpty() && !ui.busy) {
                item { Text("No employees found.", color = KioskTheme.colors.muted, modifier = Modifier.padding(Spacing.md)) }
            }
        }
    }
}

@Composable
private fun EnrollmentChip(status: String?) {
    val colors = KioskTheme.colors
    val (label, bg, fg) = when (status) {
        "active" -> Triple("Enrolled", colors.checkInSoft, colors.checkIn)
        "pending_confirmation" -> Triple("Awaiting confirmation", colors.warningSoft, colors.onWarningSoft)
        else -> Triple("Not enrolled", MaterialTheme.colorScheme.surfaceVariant, colors.muted)
    }
    Text(label, style = MaterialTheme.typography.labelMedium, color = fg, modifier = Modifier.clip(Shapes.pill).background(bg).padding(horizontal = Spacing.sm, vertical = Spacing.xxs))
}

@Composable
private fun PrivacyContent(e: ManagerEmployee, config: KioskConfig?, vm: ManagerViewModel) {
    val restaurant = config?.restaurant?.name ?: "your employer"
    Page {
        Text("Privacy notice for ${e.fullName}", style = MaterialTheme.typography.headlineSmall)
        Text("Please let the employee read this, or read it to them.", color = KioskTheme.colors.muted)
        NoticeSection("What we collect", "A numeric face template — a list of numbers calculated from your face. It is not a photo and a photo cannot be rebuilt from it. A reference photo is stored only if you agree to it on the next screen.")
        NoticeSection("Why", "Only to record your attendance (check-in and check-out) at $restaurant. It is not used for anything else.")
        NoticeSection("Where it is kept", "Encrypted on the restaurant's attendance server, and on this kiosk so it can recognise you. It is shared with no one else.")
        NoticeSection("How long", "While you work here. It is deleted when your employment ends, or earlier whenever you ask.")
        NoticeSection("Your choice", "You don't have to use face check-in. You can use your staff ID and PIN instead, and you can withdraw your consent at any time.")
        NoticeSection("Questions or deletion requests", "Speak to the owner or manager of $restaurant.")
        Text("Notice version ${config?.consentNoticeVersion ?: "-"}", style = MaterialTheme.typography.labelSmall, color = KioskTheme.colors.muted)
        KioskPrimaryButton("Continue to consent", { vm.go(ManagerScreen.Consent(e)) }, modifier = Modifier.fillMaxWidth())
        KioskTextLink("The employee prefers PIN — cancel", { vm.go(ManagerScreen.Employees) })
    }
}

@Composable
private fun NoticeSection(title: String, body: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(body, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ConsentContent(e: ManagerEmployee, ui: ManagerUi, vm: ManagerViewModel) {
    Page {
        Text("Consent", style = MaterialTheme.typography.headlineSmall)
        Text("How did ${e.fullName} give consent?", style = MaterialTheme.typography.titleMedium)
        ConsentMethod.entries.forEach { m ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(Shapes.small)
                    .selectable(selected = ui.consentMethod == m, onClick = { vm.setConsentMethod(m) }, role = Role.RadioButton)
                    .padding(vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = ui.consentMethod == m, onClick = null)
                Spacer(Modifier.width(Spacing.sm))
                Text(m.label, style = MaterialTheme.typography.bodyLarge)
            }
        }
        HorizontalDivider(color = KioskTheme.colors.hairline)
        CheckRow(ui.consentAgreed, vm::setConsentAgreed, "${e.fullName} agrees to face check-in as described in the notice")
        CheckRow(ui.storePhoto, vm::setStorePhoto, "Also store one reference photo (optional, helps the owner review records)")
        ErrorText(ui.error)
        KioskPrimaryButton(
            "Start capture", { vm.consentContinue(e) },
            enabled = ui.consentAgreed && ui.consentMethod != null, modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, label: String) {
    Row(
        Modifier.fillMaxWidth().clip(Shapes.small).toggleable(value = checked, onValueChange = onChange, role = Role.Checkbox).padding(vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null)
        Spacer(Modifier.width(Spacing.sm))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ManagerCamera(screen: ManagerScreen, vm: ManagerViewModel, env: ManagerEnv, modifier: Modifier) {
    val analyzer = remember(screen) { vm.analyzerFor(screen) }
    Box(modifier.clip(Shapes.card).background(Color.Black)) {
        CameraPreview(analyzer = analyzer, executor = env.executor, onError = { /* shown via engine/camera status */ }, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun CaptureContent(s: ManagerScreen.Capture, ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    val c = ui.capture
    Page {
        Text("Capture samples · ${s.employee.fullName}", style = MaterialTheme.typography.headlineSmall)
        LinearProgressIndicator(progress = { c.count.toFloat() / c.total }, modifier = Modifier.fillMaxWidth())
        Text("${c.count} of ${c.total} samples", color = KioskTheme.colors.muted)
        if (c.pose != null) {
            ManagerCamera(s, vm, env, Modifier.fillMaxWidth().aspectRatio(3f / 4f))
            Text(c.pose.instruction, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
            c.liveHint?.let { Text(it, color = if (c.liveOk) KioskTheme.colors.online else KioskTheme.colors.muted) }
            c.message?.let { ErrorText(it) }
            if (c.capturing) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(24.dp))
                    Spacer(Modifier.width(Spacing.sm))
                    Text("Capturing…")
                }
            } else {
                KioskPrimaryButton("Capture sample ${c.count + 1}", vm::requestSample, modifier = Modifier.fillMaxWidth())
            }
        } else {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = KioskTheme.colors.online, modifier = Modifier.size(64.dp))
            Text("All samples captured.", style = MaterialTheme.typography.titleLarge)
            c.message?.let { ErrorText(it) }
            KioskPrimaryButton("Continue", { vm.captureContinue(s.employee) }, modifier = Modifier.fillMaxWidth())
            KioskSecondaryButton("Start over", vm::restartCapture, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun PhotoContent(s: ManagerScreen.Photo, ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    Page {
        Text("Reference photo (optional)", style = MaterialTheme.typography.headlineSmall)
        Text("Stored only because the employee agreed. A small face crop, JPEG under 200 KB.", color = KioskTheme.colors.muted)
        val photo = ui.photo
        if (photo == null) {
            ManagerCamera(s, vm, env, Modifier.fillMaxWidth().aspectRatio(3f / 4f))
            ErrorText(ui.error)
            KioskPrimaryButton("Take photo", vm::requestPhoto, enabled = !ui.busy, modifier = Modifier.fillMaxWidth())
        } else {
            val bitmap = remember(photo) { BitmapFactory.decodeByteArray(photo, 0, photo.size) }
            if (bitmap != null) {
                Image(
                    bitmap.asImageBitmap(), contentDescription = "Reference photo preview",
                    contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().height(320.dp).clip(Shapes.card),
                )
            }
            Text("${photo.size / 1024} KB", color = KioskTheme.colors.muted)
            KioskPrimaryButton("Use this photo", { vm.go(ManagerScreen.Confirm(s.employee)) }, modifier = Modifier.fillMaxWidth())
            KioskSecondaryButton("Retake", vm::retakePhoto, modifier = Modifier.fillMaxWidth())
        }
        KioskTextLink("Skip — don't store a photo", { vm.skipPhoto(s.employee) })
    }
}

@Composable
private fun ConfirmContent(e: ManagerEmployee, ui: ManagerUi, vm: ManagerViewModel) {
    Page {
        Text("Confirm identity", style = MaterialTheme.typography.headlineSmall)
        Text("Check the person in front of the kiosk really is this employee. A wrong enrollment would record attendance for the wrong person.", color = KioskTheme.colors.muted)
        CheckRow(ui.identityConfirmed, vm::setIdentityConfirmed, "I confirm this person is ${e.fullName} (${e.staffId})")
        ErrorText(ui.error)
        Busy(ui.busy)
        KioskPrimaryButton("Save enrollment", { vm.submitEnrollment(e) }, enabled = ui.identityConfirmed && !ui.busy, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun TestContent(s: ManagerScreen.Test, ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    Page {
        Text("Enrollment saved", style = MaterialTheme.typography.headlineSmall, color = KioskTheme.colors.online)
        Text(
            if (s.enrollmentStatus == "active") "${s.employee.fullName} can now check in with their face."
            else "Status: ${s.enrollmentStatus}. The owner must confirm it in the dashboard before it is used.",
        )
        Text("Test recognition", style = MaterialTheme.typography.titleLarge)
        Text("Ask ${s.employee.fullName} to look at the camera, then tap Test.", color = KioskTheme.colors.muted)
        ManagerCamera(s, vm, env, Modifier.fillMaxWidth().aspectRatio(3f / 4f))
        Busy(ui.busy)
        ui.testResult?.let { r ->
            Card(colors = CardDefaults.cardColors(containerColor = if (r.accepted) KioskTheme.colors.checkInSoft else KioskTheme.colors.warningSoft)) {
                Column(Modifier.padding(Spacing.md)) {
                    Text(r.title, style = MaterialTheme.typography.titleLarge)
                    Text(r.detail)
                }
            }
        }
        ErrorText(ui.error)
        KioskPrimaryButton("Test now", vm::requestTest, enabled = !ui.busy, modifier = Modifier.fillMaxWidth())
        KioskSecondaryButton("Done", { vm.go(ManagerScreen.Employees) }, modifier = Modifier.fillMaxWidth())
    }
}

// --- Queue ----------------------------------------------------------------------------------------

@Composable
private fun QueueContent(ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    var confirmClear by remember { mutableStateOf(false) }
    LaunchedEffect(env.pendingCount, env.failedCount) { vm.refreshQueue() }
    Page {
        Text("Offline queue", style = MaterialTheme.typography.headlineSmall)
        Text(if (env.online) "Online" else "Offline — records will be sent when the connection returns.", color = KioskTheme.colors.muted)
        Busy(ui.busy)
        ErrorText(ui.error)
        KioskPrimaryButton("Sync now", vm::syncNow, enabled = !ui.busy, icon = Icons.Filled.Refresh, modifier = Modifier.fillMaxWidth())
        Text("Waiting to sync (${ui.pending.size})", style = MaterialTheme.typography.titleLarge)
        if (ui.pending.isEmpty()) Text("Nothing waiting.", color = KioskTheme.colors.muted)
        ui.pending.forEach { QueueRow(it, env) }
        Text("Could not be synced (${ui.failed.size})", style = MaterialTheme.typography.titleLarge)
        Text("The server refused these records and alerted the owner. Fix them with a correction in the dashboard.", color = KioskTheme.colors.muted)
        if (ui.failed.isEmpty()) Text("None.", color = KioskTheme.colors.muted)
        ui.failed.forEach { QueueRow(it, env) }
        if (ui.failed.isNotEmpty()) {
            KioskSecondaryButton("Clear failed list", { confirmClear = true }, modifier = Modifier.fillMaxWidth())
        }
    }
    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear failed records?") },
            text = { Text("They stay visible to the owner as alerts in the dashboard.") },
            confirmButton = { TextButton(onClick = { confirmClear = false; vm.clearFailed() }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun QueueRow(r: QueueRecord, env: ManagerEnv) {
    val zone = DisplayFormat.zone(env.config?.restaurant?.timezone)
    val time = DisplayFormat.dateTime(Instant.ofEpochMilli(r.entry.deviceTimeMs), zone)
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Spacing.md)) {
            Text(
                "${r.entry.employeeName ?: "Employee"} · ${if (r.entry.action.wire == "check_in") "Check-in" else "Check-out"}",
                style = MaterialTheme.typography.titleMedium,
            )
            Text("Device time $time", style = MaterialTheme.typography.bodySmall, color = KioskTheme.colors.muted)
            if (r.failedReason != null) {
                Text("Reason: ${r.failedReason}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            } else if (r.attempts > 0) {
                Text("Tried ${r.attempts}×. Last error: ${r.lastError ?: "-"}", style = MaterialTheme.typography.bodySmall, color = KioskTheme.colors.muted)
            }
        }
    }
}

// --- Device info / camera test ---------------------------------------------------------------------

@Composable
private fun DeviceInfoContent(vm: ManagerViewModel, env: ManagerEnv) {
    val zone = DisplayFormat.zone(env.config?.restaurant?.timezone)
    Page {
        Text("Device info", style = MaterialTheme.typography.headlineSmall)
        InfoRow("Device name", env.config?.device?.name ?: "-")
        InfoRow("Restaurant", env.config?.restaurant?.name ?: "-")
        InfoRow("Branch", env.config?.branch?.name ?: "-")
        InfoRow("Server", env.credentials?.serverUrl ?: "-")
        InfoRow("App version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        InfoRow(
            "Face models",
            when (val s = env.engineStatus) {
                EngineStatus.Ready -> "Loaded · checksums OK"
                EngineStatus.Loading -> "Loading…"
                EngineStatus.NotLoaded -> "Not loaded yet"
                is EngineStatus.Failed -> "Problem: ${s.message}"
            },
        )
        InfoRow("Connection", if (env.online) "Online" else "Offline")
        InfoRow("Offline queue", "${env.pendingCount} waiting · ${env.failedCount} failed")
        InfoRow("Last sync", if (env.lastSyncMs > 0) DisplayFormat.dateTime(Instant.ofEpochMilli(env.lastSyncMs), zone) else "-")
        InfoRow("Last error", env.lastError ?: "-")
        InfoRow("Recognition", env.config?.settings?.let { "threshold ${it.matchThreshold}, margin ${it.matchMargin}, liveness ${if (it.livenessRequired) "on" else "off"}" } ?: "-")
        KioskSecondaryButton("Refresh from server", vm::refreshNow, icon = Icons.Filled.Refresh, modifier = Modifier.fillMaxWidth())
        KioskSecondaryButton("Camera test", { vm.go(ManagerScreen.CameraTest) }, icon = Icons.Filled.Face, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = KioskTheme.colors.muted)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun CameraTestContent(ui: ManagerUi, vm: ManagerViewModel, env: ManagerEnv) {
    Page {
        Text("Camera test", style = MaterialTheme.typography.headlineSmall)
        ManagerCamera(ManagerScreen.CameraTest, vm, env, Modifier.fillMaxWidth().aspectRatio(3f / 4f))
        Text(
            when (val n = ui.cameraTestFaces) {
                null -> "Starting…"
                0 -> "No face detected"
                1 -> "1 face detected"
                else -> "$n faces detected"
            },
            style = MaterialTheme.typography.titleLarge,
        )
        ErrorText(ui.error)
    }
}

// --- Updates ---------------------------------------------------------------------------------------

@Composable
private fun UpdatesContent(vm: ManagerViewModel) {
    val state by vm.updates.state.collectAsState()
    val context = LocalContext.current
    Page {
        Text("App updates", style = MaterialTheme.typography.headlineSmall)
        Text("Installed: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", color = KioskTheme.colors.muted)
        when (val s = state) {
            UpdateState.Idle -> Text("Tap Check to look for a newer version.")
            UpdateState.Checking -> Busy(true)
            UpdateState.UpToDate -> Text("This kiosk is up to date.", style = MaterialTheme.typography.titleMedium)
            is UpdateState.Available -> {
                Text(
                    "Version ${s.release.versionName} (${s.release.versionCode}) is available" + if (s.mandatory) " — required" else "",
                    style = MaterialTheme.typography.titleLarge,
                    color = if (s.mandatory) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onBackground,
                )
                s.release.releaseNotes?.takeIf { it.isNotBlank() }?.let { Text(it) }
                KioskPrimaryButton("Download and verify", vm::downloadUpdate, modifier = Modifier.fillMaxWidth())
            }
            is UpdateState.Downloading -> {
                Text("Downloading ${s.release.versionName}…")
                val p = s.progress
                if (p != null) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth()) else Busy(true)
            }
            is UpdateState.Verified -> {
                Text("Download verified: checksum, package and signing certificate match.", style = MaterialTheme.typography.titleMedium, color = KioskTheme.colors.online)
                if (vm.updates.isInLockTaskMode()) {
                    ErrorText("Turn off kiosk lock (Settings) before installing; Android blocks the installer while the screen is pinned.")
                }
                if (!vm.updates.canInstallPackages()) {
                    ErrorText("Allow this app to install updates: tap below, enable \"Allow from this source\", then come back.")
                    KioskSecondaryButton(
                        "Open install permission",
                        {
                            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { context.startActivity(intent) }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                KioskPrimaryButton("Install ${s.release.versionName}", vm::installUpdate, modifier = Modifier.fillMaxWidth())
                Text("Android will ask you to confirm. The kiosk restarts on the new version; open it again if it doesn't come back by itself.", color = KioskTheme.colors.muted)
            }
            is UpdateState.Installing -> Text("Waiting for the system installer…")
            is UpdateState.Failed -> {
                ErrorText(s.message)
                Text("The current version keeps running.", color = KioskTheme.colors.muted)
                if (s.release != null) KioskSecondaryButton("Try download again", vm::downloadUpdate, modifier = Modifier.fillMaxWidth())
            }
        }
        KioskSecondaryButton("Check for updates", vm::checkUpdates, icon = Icons.Filled.Refresh, modifier = Modifier.fillMaxWidth())
    }
}

// --- Settings ----------------------------------------------------------------------------------------

@Composable
private fun SettingsContent(vm: ManagerViewModel, env: ManagerEnv) {
    var locked by remember { mutableStateOf(env.isLocked()) }
    Page {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Text("Kiosk lock", style = MaterialTheme.typography.titleLarge)
        Text(
            "Pins this app to the screen so employees can't leave it. On a managed (dedicated) device it locks without a prompt; otherwise Android asks to confirm, and unpinning needs the device PIN if you enabled it in Android settings.",
            color = KioskTheme.colors.muted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            KioskPrimaryButton("Start kiosk lock", { env.startLock(); locked = true }, icon = Icons.Filled.Lock, enabled = !locked)
            KioskSecondaryButton("Stop", { env.stopLock(); locked = false }, enabled = locked)
        }
        HorizontalDivider(color = KioskTheme.colors.hairline)
        Text("Success sound", style = MaterialTheme.typography.titleLarge)
        val serverDefault = env.config?.settings?.soundEnabled ?: true
        listOf(
            null to "Use restaurant setting (${if (serverDefault) "on" else "off"})",
            true to "Always on for this kiosk",
            false to "Always off for this kiosk",
        ).forEach { (value, label) ->
            Row(
                Modifier.fillMaxWidth().selectable(selected = env.soundOverride == value, onClick = { vm.setSoundOverride(value) }, role = Role.RadioButton).padding(vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = env.soundOverride == value, onClick = null)
                Spacer(Modifier.width(Spacing.sm))
                Text(label, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}
