package com.attendance.kiosk.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.attendance.kiosk.AppGraph
import com.attendance.kiosk.BuildConfig
import com.attendance.kiosk.core.flow.FlowState
import com.attendance.kiosk.data.PairingState
import com.attendance.kiosk.ui.manager.ManagerEnv
import com.attendance.kiosk.ui.manager.ManagerRoot
import com.attendance.kiosk.ui.manager.ManagerViewModel
import com.attendance.kiosk.ui.screens.CameraScreen
import com.attendance.kiosk.ui.screens.FailureScreen
import com.attendance.kiosk.ui.screens.HomeData
import com.attendance.kiosk.ui.screens.HomeScreen
import com.attendance.kiosk.ui.screens.PairingScreen
import com.attendance.kiosk.ui.screens.PinScreen
import com.attendance.kiosk.ui.screens.SubmittingScreen
import com.attendance.kiosk.ui.screens.SuccessScreen
import com.attendance.kiosk.ui.screens.UnknownFaceScreen
import com.attendance.kiosk.ui.screens.WrongActionScreen

@Composable
fun KioskRoot(
    vm: KioskViewModel,
    managerVm: ManagerViewModel,
    graph: AppGraph,
    isLocked: () -> Boolean,
    startLock: () -> Unit,
    stopLock: () -> Unit,
) {
    val pairing by vm.pairing.collectAsStateWithLifecycle()
    val manager by managerVm.ui.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    val config by vm.config.collectAsStateWithLifecycle()
    val counts by vm.counts.collectAsStateWithLifecycle()
    val online by vm.online.collectAsStateWithLifecycle()
    val update by vm.updateAvailable.collectAsStateWithLifecycle()
    val lastSync by graph.repository.lastSyncMs.collectAsStateWithLifecycle()
    val lastError by graph.repository.lastError.collectAsStateWithLifecycle()
    val soundOverride by graph.repository.soundOverride.collectAsStateWithLifecycle()

    val paired = pairing as? PairingState.Paired
    if (paired == null) {
        BackHandler(enabled = true) { /* kiosk: stay on the pairing screen */ }
        PairingScreen(graph.repository, revoked = pairing is PairingState.Revoked)
        return
    }

    if (manager.open) {
        BackHandler(enabled = true) { managerVm.back() }
        ManagerRoot(
            managerVm,
            ManagerEnv(
                config = config,
                credentials = paired.credentials,
                online = online,
                pendingCount = counts.pending,
                failedCount = counts.failed,
                lastSyncMs = lastSync,
                lastError = lastError,
                engineStatus = graph.faceEngine.status,
                soundOverride = soundOverride,
                executor = graph.analysisExecutor,
                isLocked = isLocked,
                startLock = startLock,
                stopLock = stopLock,
            ),
        )
        return
    }

    val pinEnabled = config?.settings?.pinFallbackEnabled ?: true
    // Back never leaves the kiosk; it behaves like Cancel / Back to home.
    BackHandler(enabled = true) {
        when (state) {
            is FlowState.Camera, is FlowState.PinEntry, is FlowState.Failure, is FlowState.UnknownFace -> vm.cancel()
            is FlowState.Success, is FlowState.WrongAction -> vm.backHome()
            else -> Unit
        }
    }

    when (val s = state) {
        FlowState.Home, FlowState.DeviceRevoked -> HomeScreen(
            data = HomeData(
                restaurantName = config?.restaurant?.name ?: "Attendance",
                branchName = config?.branch?.name,
                timezone = config?.restaurant?.timezone,
                instructions = config?.settings?.employeeInstructions ?: "Tap CHECK IN when you arrive and CHECK OUT when you leave.",
                online = online,
                pending = counts.pending,
                failed = counts.failed,
                pinEnabled = pinEnabled,
                update = update,
                appVersion = BuildConfig.VERSION_NAME,
            ),
            onAction = vm::tap,
            onPin = vm::openPinFromHome,
            onManager = managerVm::openLogin,
        )
        is FlowState.Camera -> {
            val eventId = s.attempt.eventId
            val analyzer = remember(eventId) { vm.analyzerFor(eventId) }
            CameraScreen(
                state = s,
                online = online,
                pinEnabled = pinEnabled,
                analyzer = analyzer,
                executor = graph.analysisExecutor,
                onCancel = vm::cancel,
                onPin = vm::openPinForAttempt,
                onCameraIssue = { issue -> vm.onCameraIssue(eventId, issue) },
                onPermissionDenied = { vm.onPermissionDenied(eventId) },
            )
        }
        is FlowState.Submitting -> SubmittingScreen(s)
        is FlowState.Success -> SuccessScreen(s, onDone = vm::backHome)
        is FlowState.WrongAction -> WrongActionScreen(s, onHome = vm::backHome)
        is FlowState.Failure -> FailureScreen(s, onRetry = vm::retry, onPin = vm::openPinForAttempt, onHome = vm::cancel)
        is FlowState.UnknownFace -> UnknownFaceScreen(s, onRetry = vm::retry, onPin = vm::openPinForAttempt, onHome = vm::cancel)
        is FlowState.PinEntry -> PinScreen(
            state = s,
            online = online,
            onChooseAction = vm::choosePinAction,
            onSubmit = vm::submitPin,
            onCancel = vm::cancel,
        )
    }
}
