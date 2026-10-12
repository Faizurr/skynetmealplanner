package com.attendance.kiosk.ui

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.attendance.kiosk.KioskApplication
import com.attendance.kiosk.camera.CameraIssue
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.api.KioskConfig
import com.attendance.kiosk.core.api.KioskSettings
import com.attendance.kiosk.core.face.DetectionStep
import com.attendance.kiosk.core.face.RecognitionSession
import com.attendance.kiosk.core.face.RecognitionUpdate
import com.attendance.kiosk.core.flow.Attempt
import com.attendance.kiosk.core.flow.AttendanceFlow
import com.attendance.kiosk.core.flow.FlowEffect
import com.attendance.kiosk.core.flow.FlowState
import com.attendance.kiosk.core.flow.OfflineSink
import com.attendance.kiosk.core.liveness.HeadTurnChallenge
import com.attendance.kiosk.core.liveness.TurnDirection
import com.attendance.kiosk.core.queue.QueueCounts
import com.attendance.kiosk.data.PairingState
import com.attendance.kiosk.update.UpdateState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * Employee-facing kiosk logic: drives the core [AttendanceFlow], owns the per-attempt
 * [RecognitionSession] and turns camera frames into recognition updates on the single analysis
 * thread. No heavy work happens on the main thread.
 */
class KioskViewModel(app: Application) : AndroidViewModel(app) {
    private companion object {
        const val TAG = "KioskViewModel"
        /** ≈ 8 analysed frames per second at most. */
        const val FRAME_INTERVAL_MS = 125L
    }

    private val graph = (app as KioskApplication).graph
    private val repo = graph.repository
    private val random = SecureRandom()

    private val _state = MutableStateFlow<FlowState>(FlowState.Home)
    val state: StateFlow<FlowState> = _state.asStateFlow()

    private val flow = AttendanceFlow(
        clock = { System.currentTimeMillis() },
        lastActions = graph.stores.lastActions,
        offlineSink = OfflineSink { entry ->
            try {
                val saved = graph.queue.enqueue(entry) || graph.queue.contains(entry.eventId)
                repo.refreshCounts()
                saved
            } catch (e: Exception) {
                Log.e(TAG, "offline save failed", e)
                false
            }
        },
        onState = { _state.value = it },
    )

    val pairing: StateFlow<PairingState> = repo.pairing
    val config: StateFlow<KioskConfig?> = repo.config
    val counts: StateFlow<QueueCounts> = repo.counts
    val online: StateFlow<Boolean> = combine(repo.systemOnline, repo.reachable) { sys, reach -> sys && reach }
        .stateIn(viewModelScope, SharingStarted.Eagerly, true)
    val updateAvailable: StateFlow<UpdateState.Available?> = graph.updates.available

    // Recognition session of the current camera attempt. Only touched on the analysis thread.
    @Volatile private var session: RecognitionSession? = null
    @Volatile private var sessionEventId: String? = null

    init {
        viewModelScope.launch {
            combine(repo.config, repo.soundOverride) { c, o -> c to o }.collect { (c, o) ->
                flow.updateSettings(c?.settings ?: KioskSettings(), c?.restaurant?.timezone, o)
            }
        }
        viewModelScope.launch {
            repo.pairing.collect { p ->
                if (p is PairingState.Paired && flow.state == FlowState.DeviceRevoked) flow.reset()
                if (p !is PairingState.Paired) {
                    clearSession()
                    flow.reset()
                }
            }
        }
        // Timeouts must fire even if the camera delivers no frames at all.
        viewModelScope.launch {
            while (isActive) {
                delay(400)
                onTick()
            }
        }
    }

    // --- Employee actions ---------------------------------------------------------------------

    fun tap(action: Action) {
        flow.tapAction(action)?.let(::startSession)
    }

    fun cancel() {
        if (flow.cancel()) clearSession()
    }

    fun retry() {
        if (flow.retry()) (flow.state as? FlowState.Camera)?.attempt?.let(::startSession)
    }

    fun backHome() {
        if (flow.backHome()) clearSession()
    }

    fun openPinFromHome() {
        flow.openPinFromHome()
    }

    fun openPinForAttempt() {
        if (flow.openPinForAttempt()) clearSession()
    }

    fun choosePinAction(action: Action) {
        flow.choosePinAction(action)
    }

    fun submitPin(staffId: String, pin: String) {
        flow.submitPin(staffId, pin)?.let { handleEffects(listOf(it)) }
    }

    fun onCameraIssue(eventId: String, issue: CameraIssue) {
        flow.onCameraError(eventId, permissionDenied = false, message = issue.message)
        clearSession()
    }

    fun onPermissionDenied(eventId: String) {
        flow.onCameraError(
            eventId, permissionDenied = true,
            message = "Face check-in needs the camera. You can allow camera access in Settings, or use your staff PIN.",
        )
        clearSession()
    }

    // --- Recognition --------------------------------------------------------------------------

    private fun startSession(attempt: Attempt) {
        val settings = repo.config.value?.settings ?: KioskSettings()
        val challenge = if (settings.livenessRequired) {
            HeadTurnChallenge(if (random.nextBoolean()) TurnDirection.LEFT else TurnDirection.RIGHT)
        } else {
            null
        }
        val s = RecognitionSession(repo.templates.value, settings.matchThreshold, settings.matchMargin, challenge)
        graph.analysisExecutor.execute {
            session = s
            sessionEventId = attempt.eventId
        }
    }

    private fun clearSession() {
        graph.analysisExecutor.execute {
            session = null
            sessionEventId = null
        }
    }

    /** A stable analyser for one attempt; frames are dropped once the attempt is over. */
    fun analyzerFor(eventId: String): ImageAnalysis.Analyzer {
        var lastProcessed = 0L
        return ImageAnalysis.Analyzer { image ->
            try {
                val now = SystemClock.elapsedRealtime()
                if (now - lastProcessed >= FRAME_INTERVAL_MS) {
                    lastProcessed = now
                    analyzeFrame(eventId, image, now)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "frame analysis failed", t)
            } finally {
                image.close()
            }
        }
    }

    private fun analyzeFrame(eventId: String, image: ImageProxy, now: Long) {
        if (!flow.isCameraActive(eventId)) return
        val s = session
        if (s == null || sessionEventId != eventId || s.isFinished) return
        val engine = graph.faceEngine
        if (!engine.ensureLoaded()) {
            flow.onCameraError(eventId, false, "Face recognition could not start on this device. Please use your staff PIN or tell your manager.")
            return
        }
        val bgr = graph.frameConverter.toBgr(image)
        try {
            val detections = engine.detect(bgr)
            val update = when (val step = s.onDetections(detections.faces, now)) {
                is DetectionStep.Done -> step.update
                is DetectionStep.NeedEmbedding -> {
                    val index = detections.faces.indexOf(step.face)
                    val embedding = engine.embed(bgr, detections.rows[index])
                    s.onEmbedding(step.face, embedding.vector, now)
                }
            }
            dispatch(eventId, update)
        } finally {
            bgr.release()
        }
    }

    private fun onTick() {
        val cam = flow.state as? FlowState.Camera ?: return
        val id = cam.attempt.eventId
        graph.analysisExecutor.execute {
            if (!flow.isCameraActive(id)) return@execute
            val s = session?.takeIf { sessionEventId == id }
            if (flow.isCameraExpired(id)) {
                dispatch(id, s?.onAttemptTimeout() ?: RecognitionUpdate.NoFaceTimeout)
                return@execute
            }
            s?.tick(SystemClock.elapsedRealtime())?.let { dispatch(id, it) }
        }
    }

    private fun dispatch(eventId: String, update: RecognitionUpdate) {
        handleEffects(flow.onRecognition(eventId, update))
    }

    private fun handleEffects(effects: List<FlowEffect>) {
        for (e in effects) {
            when (e) {
                is FlowEffect.Submit -> viewModelScope.launch(Dispatchers.IO) {
                    val result = repo.submitAttendance(e.request)
                    handleEffects(flow.onSubmitResult(e.eventId, result))
                }
                is FlowEffect.ReportUnknownFace -> graph.appScope.launch {
                    runCatching { repo.reportUnknownFace(e.action, e.bestScore) }
                }
                is FlowEffect.PlaySuccess -> if (e.sound) graph.sound.play()
                FlowEffect.DeviceRevoked -> Unit // the repository switches to the pairing screen
            }
        }
    }
}
