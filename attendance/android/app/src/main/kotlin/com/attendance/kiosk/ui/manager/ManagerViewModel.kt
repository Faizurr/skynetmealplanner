package com.attendance.kiosk.ui.manager

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.attendance.kiosk.KioskApplication
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.Consent
import com.attendance.kiosk.core.api.ConsentMethod
import com.attendance.kiosk.core.api.EnrollmentRequest
import com.attendance.kiosk.core.api.ManagerEmployee
import com.attendance.kiosk.core.api.describe
import com.attendance.kiosk.core.enroll.EnrollPose
import com.attendance.kiosk.core.enroll.EnrollmentCapture
import com.attendance.kiosk.core.enroll.SampleCheck
import com.attendance.kiosk.core.enroll.SampleIssue
import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.FrameGate
import com.attendance.kiosk.core.face.FrameGateResult
import com.attendance.kiosk.core.manager.ManagerSession
import com.attendance.kiosk.core.queue.QueueRecord
import com.attendance.kiosk.face.ReferencePhoto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Base64

sealed interface ManagerScreen {
    data object Login : ManagerScreen
    data object Menu : ManagerScreen
    data object Employees : ManagerScreen
    data class Privacy(val employee: ManagerEmployee) : ManagerScreen
    data class Consent(val employee: ManagerEmployee) : ManagerScreen
    data class Capture(val employee: ManagerEmployee) : ManagerScreen
    data class Photo(val employee: ManagerEmployee) : ManagerScreen
    data class Confirm(val employee: ManagerEmployee) : ManagerScreen
    data class Test(val employee: ManagerEmployee, val enrollmentStatus: String) : ManagerScreen
    data object Queue : ManagerScreen
    data object DeviceInfo : ManagerScreen
    data object CameraTest : ManagerScreen
    data object Updates : ManagerScreen
    data object Settings : ManagerScreen
}

data class CaptureUi(
    val pose: EnrollPose? = EnrollPose.STRAIGHT,
    val count: Int = 0,
    val total: Int = EnrollPose.entries.size,
    val liveHint: String? = null,
    val liveOk: Boolean = false,
    val capturing: Boolean = false,
    val message: String? = null,
)

data class TestResult(val accepted: Boolean, val title: String, val detail: String)

data class ManagerUi(
    val open: Boolean = false,
    val screen: ManagerScreen = ManagerScreen.Login,
    val managerName: String? = null,
    val remainingSeconds: Int = 0,
    val busy: Boolean = false,
    val error: String? = null,
    val employees: List<ManagerEmployee> = emptyList(),
    val query: String = "",
    val consentMethod: ConsentMethod? = null,
    val consentAgreed: Boolean = false,
    val storePhoto: Boolean = false,
    val capture: CaptureUi = CaptureUi(),
    val photo: ByteArray? = null,
    val identityConfirmed: Boolean = false,
    val testResult: TestResult? = null,
    val cameraTestFaces: Int? = null,
    val pending: List<QueueRecord> = emptyList(),
    val failed: List<QueueRecord> = emptyList(),
)

/**
 * Manager mode: owner/manager sign-in (token in memory only, ends after 15 min or 3 min of
 * inactivity), enrollment with privacy notice + consent, test recognition, offline queue,
 * device info, updates and local settings.
 */
class ManagerViewModel(app: Application) : AndroidViewModel(app) {
    private companion object {
        const val TAG = "ManagerViewModel"
        const val CAPTURE_WINDOW_MS = 4_000L
        const val FRAME_INTERVAL_MS = 150L
    }

    private val graph = (app as KioskApplication).graph
    private val repo = graph.repository
    val updates = graph.updates

    private val _ui = MutableStateFlow(ManagerUi())
    val ui: StateFlow<ManagerUi> = _ui.asStateFlow()

    @Volatile private var session: ManagerSession? = null
    @Volatile private var capture = EnrollmentCapture()

    // Capture requests (read on the analysis thread).
    @Volatile private var captureDeadline = 0L
    @Volatile private var photoRequested = false
    @Volatile private var testDeadline = 0L

    init {
        viewModelScope.launch {
            while (isActive) {
                delay(1_000)
                val s = session
                if (s != null) {
                    val now = SystemClock.elapsedRealtime()
                    if (s.isExpired(now)) {
                        close()
                    } else {
                        _ui.update { it.copy(remainingSeconds = (s.remainingMs(now) / 1000).toInt()) }
                    }
                }
            }
        }
    }

    // --- Navigation -------------------------------------------------------------------------

    fun openLogin() {
        _ui.value = ManagerUi(open = true, screen = ManagerScreen.Login)
    }

    fun close() {
        session = null
        capture = EnrollmentCapture()
        captureDeadline = 0; photoRequested = false; testDeadline = 0
        _ui.value = ManagerUi(open = false)
    }

    /** Any touch in manager mode counts as activity. */
    fun touch() {
        session?.touch(SystemClock.elapsedRealtime())
    }

    fun go(screen: ManagerScreen) {
        touch()
        _ui.update { it.copy(screen = screen, error = null) }
        when (screen) {
            ManagerScreen.Employees -> loadEmployees()
            ManagerScreen.Queue -> refreshQueue()
            else -> Unit
        }
    }

    fun back() {
        val s = _ui.value.screen
        val target = when (s) {
            ManagerScreen.Login -> { close(); return }
            ManagerScreen.Menu -> { close(); return }
            is ManagerScreen.Privacy, is ManagerScreen.Test -> ManagerScreen.Employees
            is ManagerScreen.Consent -> ManagerScreen.Privacy(s.employee)
            is ManagerScreen.Capture -> ManagerScreen.Consent(s.employee)
            is ManagerScreen.Photo -> ManagerScreen.Capture(s.employee)
            is ManagerScreen.Confirm -> if (_ui.value.storePhoto) ManagerScreen.Photo(s.employee) else ManagerScreen.Capture(s.employee)
            ManagerScreen.CameraTest -> ManagerScreen.DeviceInfo
            else -> ManagerScreen.Menu
        }
        go(target)
    }

    private fun setError(msg: String?) = _ui.update { it.copy(error = msg, busy = false) }

    /** Common handling of manager API failures. */
    private fun handleFailure(r: ApiResult<*>, fallback: String) {
        if (r is ApiResult.Http && r.isManagerExpired) {
            session = null
            _ui.update { ManagerUi(open = true, screen = ManagerScreen.Login, error = "Your manager session expired. Please sign in again.") }
            return
        }
        val msg = when (r) {
            is ApiResult.Http -> r.message ?: fallback
            is ApiResult.Network -> "Can't reach the server. Manager mode needs an internet connection."
            else -> fallback
        }
        setError(msg)
    }

    // --- Login -------------------------------------------------------------------------------

    fun login(email: String, password: String) {
        if (email.isBlank() || password.isEmpty()) {
            setError("Enter your email and password.")
            return
        }
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            when (val r = repo.managerLogin(email, password)) {
                is ApiResult.Ok -> {
                    session = ManagerSession(r.value.managerToken, r.value.fullName, r.value.role, SystemClock.elapsedRealtime(), r.value.expiresInSeconds)
                    _ui.update { it.copy(busy = false, screen = ManagerScreen.Menu, managerName = r.value.fullName, error = null) }
                }
                else -> handleFailure(r, "Sign-in failed.")
            }
        }
    }

    private fun token(): String? {
        val s = session
        if (s == null || s.isExpired(SystemClock.elapsedRealtime())) {
            close()
            return null
        }
        return s.token
    }

    // --- Enrollment ---------------------------------------------------------------------------

    fun setQuery(q: String) = _ui.update { it.copy(query = q) }

    fun loadEmployees() {
        val t = token() ?: return
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            when (val r = repo.managerEmployees(t)) {
                is ApiResult.Ok -> _ui.update { it.copy(busy = false, employees = r.value.employees) }
                else -> handleFailure(r, "Could not load employees.")
            }
        }
    }

    fun startEnrollment(e: ManagerEmployee) {
        if (repo.config.value?.consentNoticeVersion.isNullOrBlank()) {
            setError("The kiosk has not loaded its configuration yet. Check the connection and try again.")
            return
        }
        capture = EnrollmentCapture()
        _ui.update {
            it.copy(
                screen = ManagerScreen.Privacy(e), consentMethod = null, consentAgreed = false, storePhoto = false,
                capture = CaptureUi(), photo = null, identityConfirmed = false, testResult = null, error = null,
            )
        }
    }

    fun setConsentMethod(m: ConsentMethod) = _ui.update { it.copy(consentMethod = m) }
    fun setConsentAgreed(v: Boolean) = _ui.update { it.copy(consentAgreed = v) }
    fun setStorePhoto(v: Boolean) = _ui.update { it.copy(storePhoto = v) }
    fun setIdentityConfirmed(v: Boolean) = _ui.update { it.copy(identityConfirmed = v) }

    fun consentContinue(e: ManagerEmployee) {
        val u = _ui.value
        if (u.consentMethod == null || !u.consentAgreed) {
            setError("Choose how consent was given and tick \"Employee agrees\".")
            return
        }
        capture = EnrollmentCapture()
        _ui.update { it.copy(screen = ManagerScreen.Capture(e), capture = CaptureUi(), error = null) }
    }

    fun requestSample() {
        touch()
        captureDeadline = SystemClock.elapsedRealtime() + CAPTURE_WINDOW_MS
        _ui.update { it.copy(capture = it.capture.copy(capturing = true, message = null)) }
    }

    fun restartCapture() {
        capture = EnrollmentCapture()
        _ui.update { it.copy(capture = CaptureUi()) }
    }

    fun captureContinue(e: ManagerEmployee) {
        if (!capture.isComplete) return
        val threshold = repo.config.value?.settings?.matchThreshold ?: 0.5
        if (!capture.consistencyOk(threshold)) {
            restartCapture()
            _ui.update {
                it.copy(capture = it.capture.copy(message = "The samples don't look consistent (similarity %.2f). Make sure only the employee is in frame with good light, then capture again.".format(capture.minPairSimilarity())))
            }
            return
        }
        _ui.update { it.copy(screen = if (it.storePhoto) ManagerScreen.Photo(e) else ManagerScreen.Confirm(e), error = null) }
    }

    fun requestPhoto() {
        touch()
        photoRequested = true
        _ui.update { it.copy(busy = true, error = null) }
    }

    fun retakePhoto() = _ui.update { it.copy(photo = null) }

    fun skipPhoto(e: ManagerEmployee) = _ui.update { it.copy(photo = null, storePhoto = false, screen = ManagerScreen.Confirm(e)) }

    fun submitEnrollment(e: ManagerEmployee) {
        val t = token() ?: return
        val u = _ui.value
        val method = u.consentMethod
        val notice = repo.config.value?.consentNoticeVersion
        if (method == null || !u.consentAgreed || notice.isNullOrBlank()) {
            setError("Consent is missing.")
            return
        }
        if (!u.identityConfirmed) {
            setError("Please confirm the employee's identity.")
            return
        }
        if (!capture.isComplete) {
            setError("Capture all samples first.")
            return
        }
        val req = EnrollmentRequest(
            employeeId = e.id,
            embeddings = capture.encoded(),
            consent = Consent(confirmed = true, method = method, noticeVersion = notice),
            confirmIdentity = true,
            photoJpegBase64 = if (u.storePhoto) u.photo?.let { Base64.getEncoder().encodeToString(it) } else null,
        )
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            when (val r = repo.enroll(t, req)) {
                is ApiResult.Ok -> {
                    runCatching { repo.refreshTemplates() }
                    _ui.update { it.copy(busy = false, screen = ManagerScreen.Test(e, r.value.status), testResult = null) }
                }
                is ApiResult.Http -> when (r.code) {
                    "inconsistent_samples" -> {
                        capture = EnrollmentCapture()
                        _ui.update {
                            it.copy(busy = false, screen = ManagerScreen.Capture(e), capture = CaptureUi(message = r.message ?: "The samples were not consistent. Please capture again."))
                        }
                    }
                    "face_already_enrolled" -> setError(r.message ?: "This face is already enrolled for another employee.")
                    else -> handleFailure(r, "Enrollment failed.")
                }
                else -> handleFailure(r, "Enrollment failed.")
            }
        }
    }

    fun requestTest() {
        touch()
        testDeadline = SystemClock.elapsedRealtime() + CAPTURE_WINDOW_MS
        _ui.update { it.copy(busy = true, testResult = null, error = null) }
    }

    private fun runVerify(embedding: FloatArray, expected: ManagerEmployee) {
        val t = token() ?: return
        viewModelScope.launch(Dispatchers.IO) {
            when (val r = repo.verify(t, EmbeddingCodec.encode(embedding))) {
                is ApiResult.Ok -> {
                    val v = r.value
                    val result = when {
                        v.accepted && v.employee?.id == expected.id -> TestResult(true, "Recognised: ${expected.fullName}", "Score %.2f. Recognition is working for this employee.".format(v.score))
                        v.accepted -> TestResult(false, "Matched someone else: ${v.employee?.fullName}", "Score %.2f. Please re-enrol and check you selected the right employee.".format(v.score))
                        else -> TestResult(false, "Not recognised", "Reason: ${v.reason ?: "unknown"}, best score %.2f. Try better lighting or re-enrol.".format(v.score))
                    }
                    _ui.update { it.copy(busy = false, testResult = result) }
                }
                else -> handleFailure(r, "Test failed.")
            }
        }
    }

    // --- Camera analysis for manager screens -------------------------------------------------

    /** Analyser for capture / photo / test / camera-test screens (runs on the analysis thread). */
    fun analyzerFor(screen: ManagerScreen): ImageAnalysis.Analyzer {
        var last = 0L
        return ImageAnalysis.Analyzer { image ->
            try {
                val now = SystemClock.elapsedRealtime()
                if (now - last >= FRAME_INTERVAL_MS) {
                    last = now
                    analyze(screen, image, now)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "manager analysis failed", t)
            } finally {
                image.close()
            }
        }
    }

    private fun analyze(screen: ManagerScreen, image: androidx.camera.core.ImageProxy, now: Long) {
        if (_ui.value.screen != screen) return
        val engine = graph.faceEngine
        if (!engine.ensureLoaded()) {
            setError("Face recognition could not start: ${engine.status}")
            return
        }
        val bgr = graph.frameConverter.toBgr(image)
        try {
            val det = engine.detect(bgr)
            when (screen) {
                is ManagerScreen.Capture -> {
                    val check = capture.checkDetections(det.faces)
                    val requested = captureDeadline > 0
                    if (check is SampleCheck.Rejected) {
                        _ui.update { it.copy(capture = it.capture.copy(liveHint = check.issue.message, liveOk = false)) }
                    } else {
                        _ui.update { it.copy(capture = it.capture.copy(liveHint = "Looks good. Tap Capture.", liveOk = true)) }
                    }
                    if (!requested) return
                    if (now > captureDeadline) {
                        captureDeadline = 0
                        val why = (check as? SampleCheck.Rejected)?.issue?.message ?: SampleIssue.BLURRY.message
                        _ui.update { it.copy(capture = it.capture.copy(capturing = false, message = "Couldn't take a good sample. $why")) }
                        return
                    }
                    if (check is SampleCheck.Ok) {
                        val idx = det.faces.indexOf(check.face)
                        val emb = engine.embed(bgr, det.rows[idx])
                        when (val offered = capture.offer(check.face, emb.vector, emb.sharpness)) {
                            is SampleCheck.Ok -> {
                                captureDeadline = 0
                                _ui.update {
                                    it.copy(capture = it.capture.copy(pose = capture.currentPose, count = capture.count, capturing = false, message = null))
                                }
                            }
                            is SampleCheck.Rejected -> _ui.update { it.copy(capture = it.capture.copy(liveHint = offered.issue.message, liveOk = false)) }
                        }
                    }
                }
                is ManagerScreen.Photo -> {
                    if (!photoRequested) return
                    val g = FrameGate.check(det.faces, 100f, 0.8f)
                    if (g is FrameGateResult.Usable) {
                        photoRequested = false
                        val jpeg = ReferencePhoto.encode(bgr, g.face)
                        _ui.update {
                            if (jpeg != null) it.copy(busy = false, photo = jpeg) else it.copy(busy = false, error = "Could not create a photo under 200 KB. Try again.")
                        }
                    }
                }
                is ManagerScreen.Test -> {
                    if (testDeadline == 0L) return
                    if (now > testDeadline) {
                        testDeadline = 0
                        _ui.update { it.copy(busy = false, testResult = TestResult(false, "No usable face", "Ask the employee to face the screen, alone, and try again.")) }
                        return
                    }
                    val g = FrameGate.check(det.faces, 80f, 0.8f)
                    if (g is FrameGateResult.Usable) {
                        testDeadline = 0
                        val emb = engine.embed(bgr, det.rows[det.faces.indexOf(g.face)])
                        runVerify(emb.vector, screen.employee)
                    }
                }
                ManagerScreen.CameraTest -> _ui.update { it.copy(cameraTestFaces = det.faces.size) }
                else -> Unit
            }
        } finally {
            bgr.release()
        }
    }

    // --- Queue -----------------------------------------------------------------------------------

    fun refreshQueue() {
        viewModelScope.launch(Dispatchers.IO) {
            val p = runCatching { repo.queue.pending() }.getOrDefault(emptyList())
            val f = runCatching { repo.queue.failed() }.getOrDefault(emptyList())
            _ui.update { it.copy(pending = p, failed = f) }
        }
    }

    fun syncNow() {
        touch()
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            val report = repo.syncNow(force = true)
            val p = runCatching { repo.queue.pending() }.getOrDefault(emptyList())
            val f = runCatching { repo.queue.failed() }.getOrDefault(emptyList())
            _ui.update {
                it.copy(
                    busy = false, pending = p, failed = f,
                    error = if (report != null && report.retryScheduled && report.lastError != null) {
                        "Some records could not be sent yet: ${report.lastError}"
                    } else {
                        null
                    },
                )
            }
        }
    }

    fun clearFailed() {
        viewModelScope.launch(Dispatchers.IO) {
            repo.clearFailed()
            refreshQueue()
        }
    }

    // --- Updates ---------------------------------------------------------------------------------

    fun checkUpdates() {
        touch()
        viewModelScope.launch(Dispatchers.IO) { updates.check() }
    }

    fun downloadUpdate() {
        touch()
        val s = updates.state.value
        val release = (s as? com.attendance.kiosk.update.UpdateState.Available)?.release
            ?: (s as? com.attendance.kiosk.update.UpdateState.Failed)?.release
            ?: updates.available.value?.release
            ?: return
        viewModelScope.launch(Dispatchers.IO) { updates.downloadAndVerify(release) }
    }

    fun installUpdate() {
        touch()
        val s = updates.state.value as? com.attendance.kiosk.update.UpdateState.Verified ?: return
        viewModelScope.launch(Dispatchers.IO) { updates.install(s.release, s.file) }
    }

    // --- Settings / device -----------------------------------------------------------------------

    fun setSoundOverride(v: Boolean?) {
        touch()
        repo.setSoundOverride(v)
    }

    fun unpair() {
        viewModelScope.launch(Dispatchers.IO) {
            repo.unpair()
            close()
        }
    }

    fun refreshNow() {
        touch()
        viewModelScope.launch(Dispatchers.IO) {
            repo.refreshAll()
            repo.heartbeat()
        }
    }

    @Suppress("unused")
    private fun describeFailure(r: ApiResult<*>) = r.describe()
}
