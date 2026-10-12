package com.attendance.kiosk.core.flow

import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.AttendanceRequest
import com.attendance.kiosk.core.api.AttendanceResult
import com.attendance.kiosk.core.api.KioskSettings
import com.attendance.kiosk.core.api.Method
import com.attendance.kiosk.core.face.AcceptedCandidate
import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.Guidance
import com.attendance.kiosk.core.face.RecognitionUpdate
import com.attendance.kiosk.core.format.DisplayFormat
import com.attendance.kiosk.core.liveness.LivenessFailure
import com.attendance.kiosk.core.liveness.LivenessPrompt
import com.attendance.kiosk.core.queue.QueueEntry
import java.time.Instant
import java.util.UUID

/** One employee interaction. The event id is created at tap time and reused for every retry. */
data class Attempt(
    val eventId: String,
    val action: Action,
    val startedAtMs: Long,
)

data class SuccessView(
    val action: Action,
    val headline: String,
    val greeting: String,
    val time: String,
    val date: String,
    val duration: String?,
    val message: String,
    val pendingReview: Boolean,
    /** Saved on this device only (offline); the time shown is the device time. */
    val provisional: Boolean,
    val returnSeconds: Int,
    val playSound: Boolean,
)

enum class FailureKind {
    TIMEOUT, LIVENESS, NOT_RECOGNIZED, EMPLOYEE_INACTIVE, CAMERA, CAMERA_PERMISSION,
    NETWORK, PIN_NEEDS_ONLINE, PIN_LOCKED, PIN_DISABLED, GENERIC,
}

sealed interface FlowState {
    data object Home : FlowState

    data class Camera(
        val attempt: Attempt,
        val guidance: Guidance = Guidance.POSITION_FACE,
        val livenessPrompt: LivenessPrompt? = null,
        val agreeingFrames: Int = 0,
        /** Failed tries so far in this attempt (drives Retry / PIN prominence). */
        val failures: Int = 0,
        val deadlineMs: Long,
    ) : FlowState

    data class Submitting(
        val attempt: Attempt,
        val method: Method,
        val employeeName: String?,
        val failures: Int = 0,
    ) : FlowState

    data class Success(val attempt: Attempt, val view: SuccessView) : FlowState

    /** The requested action is not possible right now. The action is never switched automatically. */
    data class WrongAction(val attempt: Attempt, val title: String, val message: String) : FlowState

    data class Failure(
        val attempt: Attempt?,
        val kind: FailureKind,
        val title: String,
        val message: String,
        val canRetry: Boolean,
        val canUsePin: Boolean,
        val failures: Int,
    ) : FlowState

    data class UnknownFace(val attempt: Attempt, val canUsePin: Boolean, val failures: Int) : FlowState

    /** Staff ID + PIN keypad. [action] is null when opened from home and not chosen yet. */
    data class PinEntry(val action: Action?, val attempt: Attempt?, val error: String? = null) : FlowState

    data object DeviceRevoked : FlowState
}

sealed interface FlowEffect {
    /** Send this request now. Results must be reported back with [AttendanceFlow.onSubmitResult]. */
    data class Submit(val eventId: String, val request: AttendanceRequest) : FlowEffect
    data class ReportUnknownFace(val action: Action, val bestScore: Double?) : FlowEffect
    data class PlaySuccess(val sound: Boolean) : FlowEffect
    data object DeviceRevoked : FlowEffect
}

/** Destination for offline saves (the encrypted queue). Returns false if it could not be saved. */
fun interface OfflineSink {
    fun enqueue(entry: QueueEntry): Boolean
}

/**
 * The kiosk attendance flow:
 * Home → Camera(action) → Submitting → Success / WrongAction / Failure → Home,
 * plus PIN fallback, unknown face, cancel and timeout.
 *
 * Guarantees (unit-tested):
 *  - a tap is accepted only on Home, so repeated taps create one attempt (button lock);
 *  - the action always stays the one the employee tapped;
 *  - cancel is possible until submission starts and afterwards nothing is submitted;
 *  - each recognition acceptance produces exactly one Submit effect;
 *  - results for stale/cancelled attempts are ignored.
 *
 * Thread-safe (all public methods synchronised). Pure logic: no I/O except via [offlineSink]
 * and [lastActions], both injected.
 */
class AttendanceFlow(
    private val clock: () -> Long,
    private val lastActions: LastActionStore,
    private val offlineSink: OfflineSink,
    private val newEventId: () -> String = { UUID.randomUUID().toString() },
    private val cameraTimeoutMs: Long = DEFAULT_CAMERA_TIMEOUT_MS,
    private val onState: (FlowState) -> Unit = {},
) {
    companion object {
        const val DEFAULT_CAMERA_TIMEOUT_MS = 20_000L
    }

    @Volatile var state: FlowState = FlowState.Home
        private set

    private var settings = KioskSettings()
    private var timezone: String? = null
    private var pendingCandidate: AcceptedCandidate? = null
    private var soundOverride: Boolean? = null

    @Synchronized
    fun updateSettings(s: KioskSettings, tz: String?, soundOverride: Boolean? = null) {
        settings = s
        timezone = tz
        this.soundOverride = soundOverride
    }

    private val pinAllowed get() = settings.pinFallbackEnabled

    private fun set(s: FlowState) {
        state = s
        onState(s)
    }

    // --- Home ---------------------------------------------------------------------------

    /**
     * Employee tapped CHECK IN / CHECK OUT. Returns the new attempt, or null when the tap was
     * ignored because an attempt is already running (debounce / button lock).
     */
    @Synchronized
    fun tapAction(action: Action): Attempt? {
        if (state !is FlowState.Home) return null
        val now = clock()
        val attempt = Attempt(newEventId(), action, now)
        set(FlowState.Camera(attempt, deadlineMs = now + cameraTimeoutMs))
        return attempt
    }

    /** "Use staff PIN" from the home screen: the action is asked for on the PIN screen. */
    @Synchronized
    fun openPinFromHome(): Boolean {
        if (state !is FlowState.Home || !pinAllowed) return false
        set(FlowState.PinEntry(action = null, attempt = null))
        return true
    }

    /** "Use PIN instead" during an attempt: keeps the chosen action (and event id). */
    @Synchronized
    fun openPinForAttempt(): Boolean {
        if (!pinAllowed) return false
        val attempt = when (val s = state) {
            is FlowState.Camera -> s.attempt
            is FlowState.Failure -> s.attempt
            is FlowState.UnknownFace -> s.attempt
            else -> return false
        } ?: return false
        set(FlowState.PinEntry(attempt.action, attempt))
        return true
    }

    /** Action chosen on the PIN screen (home path). The event id is created now, at tap time. */
    @Synchronized
    fun choosePinAction(action: Action): Boolean {
        val s = state as? FlowState.PinEntry ?: return false
        if (s.action != null) return false
        set(FlowState.PinEntry(action, Attempt(newEventId(), action, clock())))
        return true
    }

    @Synchronized
    fun submitPin(staffId: String, pin: String): FlowEffect.Submit? {
        val s = state as? FlowState.PinEntry ?: return null
        val attempt = s.attempt ?: return null
        when (val v = PinValidator.validate(staffId, pin)) {
            is PinValidation.Invalid -> {
                set(s.copy(error = v.message))
                return null
            }
            is PinValidation.Valid -> {
                pendingCandidate = null
                set(FlowState.Submitting(attempt, Method.PIN, null))
                return FlowEffect.Submit(
                    attempt.eventId,
                    AttendanceRequest(
                        eventId = attempt.eventId,
                        action = attempt.action,
                        method = Method.PIN,
                        staffId = v.staffId,
                        pin = v.pin,
                        deviceTimestamp = DisplayFormat.isoTimestamp(clock()),
                        offline = false,
                    ),
                )
            }
        }
    }

    // --- Camera -------------------------------------------------------------------------

    /** Cancel: back home, no event. Not possible once the request is in flight. */
    @Synchronized
    fun cancel(): Boolean {
        return when (state) {
            is FlowState.Submitting, FlowState.Home, FlowState.DeviceRevoked -> false
            else -> {
                pendingCandidate = null
                set(FlowState.Home)
                true
            }
        }
    }

    /** Is the camera attempt [eventId] still the active one (analysis should continue)? */
    @Synchronized
    fun isCameraActive(eventId: String): Boolean = (state as? FlowState.Camera)?.attempt?.eventId == eventId

    @Synchronized
    fun isCameraExpired(eventId: String): Boolean {
        val s = state as? FlowState.Camera ?: return false
        return s.attempt.eventId == eventId && clock() >= s.deadlineMs
    }

    /** Feeds a recognition update for camera attempt [eventId]. Returns the effects to run. */
    @Synchronized
    fun onRecognition(eventId: String, update: RecognitionUpdate): List<FlowEffect> {
        val s = state as? FlowState.Camera ?: return emptyList()
        if (s.attempt.eventId != eventId) return emptyList()
        return when (update) {
            is RecognitionUpdate.Progress -> {
                set(s.copy(guidance = update.guidance, livenessPrompt = update.livenessPrompt, agreeingFrames = update.agreeingFrames))
                emptyList()
            }
            is RecognitionUpdate.Accepted -> {
                val c = update.candidate
                pendingCandidate = c
                set(FlowState.Submitting(s.attempt, Method.FACE, c.displayName, s.failures))
                listOf(
                    FlowEffect.Submit(
                        s.attempt.eventId,
                        AttendanceRequest(
                            eventId = s.attempt.eventId,
                            action = s.attempt.action,
                            method = Method.FACE,
                            employeeId = c.employeeId,
                            embedding = EmbeddingCodec.encode(c.embedding),
                            matchScore = c.score.coerceIn(-1.0, 1.0),
                            livenessPassed = c.livenessPassed,
                            deviceTimestamp = DisplayFormat.isoTimestamp(clock()),
                            offline = false,
                        ),
                    ),
                )
            }
            is RecognitionUpdate.LivenessFailed -> {
                set(
                    failure(
                        s.attempt, FailureKind.LIVENESS,
                        if (update.reason == LivenessFailure.FACE_SWAPPED) "Only one person at a time" else "Let's try that again",
                        livenessMessage(update.reason),
                        canRetry = true, failures = s.failures + 1,
                    ),
                )
                emptyList()
            }
            is RecognitionUpdate.Unknown -> {
                set(FlowState.UnknownFace(s.attempt, pinAllowed, s.failures + 1))
                listOf(FlowEffect.ReportUnknownFace(s.attempt.action, update.bestScore))
            }
            RecognitionUpdate.NoFaceTimeout -> {
                set(
                    failure(
                        s.attempt, FailureKind.TIMEOUT, "We couldn't see your face",
                        "Stand in front of the screen with your face inside the frame and good light, then try again.",
                        canRetry = true, failures = s.failures + 1,
                    ),
                )
                emptyList()
            }
        }
    }

    /** Camera could not start (no front camera, in use, CameraX error) or permission denied. */
    @Synchronized
    fun onCameraError(eventId: String, permissionDenied: Boolean, message: String) {
        val s = state as? FlowState.Camera ?: return
        if (s.attempt.eventId != eventId) return
        set(
            if (permissionDenied) {
                failure(s.attempt, FailureKind.CAMERA_PERMISSION, "Camera access is needed", message, canRetry = true, failures = s.failures)
            } else {
                failure(s.attempt, FailureKind.CAMERA, "The camera isn't available", message, canRetry = true, failures = s.failures + 1)
            },
        )
    }

    /** Retry the same action with the same event id. */
    @Synchronized
    fun retry(): Boolean {
        val (attempt, failures) = when (val s = state) {
            is FlowState.Failure -> if (s.canRetry && s.attempt != null) s.attempt to s.failures else return false
            is FlowState.UnknownFace -> s.attempt to s.failures
            else -> return false
        }
        pendingCandidate = null
        set(FlowState.Camera(attempt, failures = failures, deadlineMs = clock() + cameraTimeoutMs))
        return true
    }

    // --- Submission ---------------------------------------------------------------------

    @Synchronized
    fun onSubmitResult(eventId: String, result: ApiResult<AttendanceResult>): List<FlowEffect> {
        val s = state as? FlowState.Submitting ?: return emptyList()
        if (s.attempt.eventId != eventId) return emptyList()
        val attempt = s.attempt
        val candidate = pendingCandidate
        return when (result) {
            is ApiResult.Ok -> {
                pendingCandidate = null
                val r = result.value
                val at = DisplayFormat.parseInstant(r.event.eventTime)?.toEpochMilli() ?: clock()
                lastActions.put(r.employee.id, LastAction(r.event.type, at))
                val sound = soundOverride ?: settings.soundEnabled
                set(
                    FlowState.Success(
                        attempt,
                        SuccessView(
                            action = attempt.action,
                            headline = r.display.headline,
                            greeting = r.display.greeting,
                            time = r.display.time,
                            date = r.display.date,
                            duration = r.display.duration,
                            message = r.display.message,
                            pendingReview = r.isPendingReview,
                            provisional = false,
                            returnSeconds = settings.successReturnSeconds,
                            playSound = sound,
                        ),
                    ),
                )
                listOf(FlowEffect.PlaySuccess(sound))
            }
            is ApiResult.Http -> handleHttp(s, result)
            is ApiResult.Network -> handleUnreachable(s, candidate)
        }
    }

    private fun handleHttp(s: FlowState.Submitting, r: ApiResult.Http): List<FlowEffect> {
        val attempt = s.attempt
        if (r.isDeviceRevoked) {
            pendingCandidate = null
            set(FlowState.DeviceRevoked)
            return listOf(FlowEffect.DeviceRevoked)
        }
        if (r.isServerError) return handleUnreachable(s, pendingCandidate)
        pendingCandidate = null
        val zone = DisplayFormat.zone(timezone)
        when (r.code) {
            "already_checked_in" -> {
                val since = DisplayFormat.parseInstant(r.body?.detailString("check_in_at"))
                val sinceText = since?.let { " since ${DisplayFormat.time(it, zone)}" } ?: ""
                set(FlowState.WrongAction(attempt, "You're already checked in", "You're already checked in$sinceText. Did you mean CHECK OUT?"))
            }
            "no_active_session" -> set(
                FlowState.WrongAction(
                    attempt, "You're not checked in",
                    "You haven't checked in yet, so there's nothing to check out from. Did you mean CHECK IN?",
                ),
            )
            "too_soon" -> {
                val at = DisplayFormat.parseInstant(r.body?.detailString("check_in_at"))
                set(FlowState.WrongAction(attempt, "You just checked in", tooSoonMessage(at?.toEpochMilli(), zone, offline = false)))
            }
            "not_recognized", "ambiguous_match", "identity_mismatch", "liveness_required" -> set(
                failure(
                    attempt, FailureKind.NOT_RECOGNIZED, "We couldn't confirm it's you",
                    r.message ?: "Please try again or use your staff PIN.", canRetry = true, failures = s.failures + 1,
                ),
            )
            "employee_inactive" -> set(
                failure(
                    attempt, FailureKind.EMPLOYEE_INACTIVE, "Please see your manager",
                    "Your staff profile isn't active, so attendance can't be recorded. Please speak to your manager.",
                    canRetry = false, failures = s.failures, allowPin = false,
                ),
            )
            "invalid_pin" -> set(FlowState.PinEntry(attempt.action, attempt, r.message ?: "Staff ID or PIN is incorrect."))
            "pin_locked" -> set(
                failure(
                    attempt, FailureKind.PIN_LOCKED, "PIN temporarily locked",
                    r.message ?: "Too many incorrect PIN attempts. Please ask a manager.", canRetry = false, failures = s.failures, allowPin = false,
                ),
            )
            "pin_disabled" -> set(
                failure(attempt, FailureKind.PIN_DISABLED, "PIN is turned off", r.message ?: "PIN attendance is disabled.", canRetry = true, failures = s.failures, allowPin = false),
            )
            else -> set(
                failure(
                    attempt, FailureKind.GENERIC, "Something went wrong",
                    r.message ?: "Please try again. If it keeps happening, tell your manager.", canRetry = true, failures = s.failures + 1,
                ),
            )
        }
        return emptyList()
    }

    /** Server unreachable (network error / timeout / 5xx). Face attempts may be saved offline. */
    private fun handleUnreachable(s: FlowState.Submitting, candidate: AcceptedCandidate?): List<FlowEffect> {
        val attempt = s.attempt
        pendingCandidate = null
        if (s.method == Method.PIN) {
            set(
                failure(
                    attempt, FailureKind.PIN_NEEDS_ONLINE, "PIN needs an internet connection",
                    "The kiosk is offline, so PINs can't be checked right now. Please try your face again or tell your manager.",
                    canRetry = true, failures = s.failures, allowPin = false,
                ),
            )
            return emptyList()
        }
        val livenessOk = candidate != null && (candidate.livenessPassed || !settings.livenessRequired)
        if (candidate == null || !settings.offlineModeEnabled || !livenessOk) {
            set(
                failure(
                    attempt, FailureKind.NETWORK, "Can't reach the server",
                    "Your attendance was NOT recorded. Please try again in a moment.", canRetry = true, failures = s.failures + 1,
                ),
            )
            return emptyList()
        }
        val now = clock()
        val zone = DisplayFormat.zone(timezone)
        when (val g = LastActionGuard.check(attempt.action, lastActions.get(candidate.employeeId), now, settings.minMinutesBetweenInAndOut)) {
            is GuardResult.AlreadyCheckedIn -> {
                set(
                    FlowState.WrongAction(
                        attempt, "You're already checked in",
                        "You're already checked in since ${DisplayFormat.time(Instant.ofEpochMilli(g.sinceMs), zone)} (saved on this device). Did you mean CHECK OUT?",
                    ),
                )
                return emptyList()
            }
            GuardResult.NotCheckedIn -> {
                set(
                    FlowState.WrongAction(
                        attempt, "You're not checked in",
                        "This kiosk shows you already checked out. Did you mean CHECK IN?",
                    ),
                )
                return emptyList()
            }
            is GuardResult.TooSoon -> {
                set(FlowState.WrongAction(attempt, "You just checked in", tooSoonMessage(g.checkInMs, zone, offline = true)))
                return emptyList()
            }
            GuardResult.Allowed -> Unit
        }
        val entry = QueueEntry(
            eventId = attempt.eventId,
            action = attempt.action,
            employeeId = candidate.employeeId,
            embedding = EmbeddingCodec.encode(candidate.embedding),
            matchScore = candidate.score.coerceIn(-1.0, 1.0),
            livenessPassed = candidate.livenessPassed,
            deviceTimestamp = DisplayFormat.isoTimestamp(now),
            deviceTimeMs = now,
            employeeName = candidate.fullName,
        )
        if (!offlineSink.enqueue(entry)) {
            set(
                failure(
                    attempt, FailureKind.NETWORK, "Couldn't save on this device",
                    "The kiosk is offline and could not save your attendance. Please tell your manager.", canRetry = true, failures = s.failures + 1,
                ),
            )
            return emptyList()
        }
        lastActions.put(candidate.employeeId, LastAction(attempt.action, now))
        val at = Instant.ofEpochMilli(now)
        val sound = soundOverride ?: settings.soundEnabled
        set(
            FlowState.Success(
                attempt,
                SuccessView(
                    action = attempt.action,
                    headline = "SAVED ON THIS DEVICE",
                    greeting = DisplayFormat.greeting(at, zone, attempt.action == Action.CHECK_OUT, candidate.displayName),
                    time = DisplayFormat.time(at, zone),
                    date = DisplayFormat.date(at, zone),
                    duration = null,
                    message = "Saved on this device — will sync when online. " +
                        (if (attempt.action == Action.CHECK_IN) "Check-in" else "Check-out") + " time shown is this device's time.",
                    pendingReview = false,
                    provisional = true,
                    returnSeconds = settings.successReturnSeconds,
                    playSound = sound,
                ),
            ),
        )
        return listOf(FlowEffect.PlaySuccess(sound))
    }

    // --- Leaving result screens ---------------------------------------------------------

    @Synchronized
    fun backHome(): Boolean {
        return when (state) {
            is FlowState.Success, is FlowState.WrongAction, is FlowState.Failure, is FlowState.UnknownFace,
            is FlowState.PinEntry -> {
                pendingCandidate = null
                set(FlowState.Home)
                true
            }
            else -> false
        }
    }

    /** After re-pairing (or on unpair) everything starts over. */
    @Synchronized
    fun reset() {
        pendingCandidate = null
        set(FlowState.Home)
    }

    @Synchronized
    fun deviceRevoked() {
        pendingCandidate = null
        set(FlowState.DeviceRevoked)
    }

    // --- Helpers ------------------------------------------------------------------------

    private fun failure(
        attempt: Attempt?,
        kind: FailureKind,
        title: String,
        message: String,
        canRetry: Boolean,
        failures: Int,
        allowPin: Boolean = true,
    ) = FlowState.Failure(attempt, kind, title, message, canRetry, allowPin && pinAllowed, failures)

    private fun livenessMessage(r: LivenessFailure) = when (r) {
        LivenessFailure.TIMEOUT -> "We didn't catch the head turn in time. Tap Retry and slowly turn your head when asked, then look straight ahead."
        LivenessFailure.FACE_SWAPPED -> "A different face appeared during the check. Only the person checking in should be in front of the camera."
        LivenessFailure.STATIC_FACE -> "We couldn't detect natural movement. Please try again and follow the on-screen prompt."
        LivenessFailure.LOST_TRACKING -> "Your face left the frame. Please keep your face inside the frame and try again."
    }

    private fun tooSoonMessage(checkInMs: Long?, zone: java.time.ZoneId, offline: Boolean): String {
        val at = checkInMs?.let { " at ${DisplayFormat.time(Instant.ofEpochMilli(it), zone)}" } ?: ""
        val mins = settings.minMinutesBetweenInAndOut.coerceAtLeast(1)
        val unit = if (mins == 1) "minute" else "minutes"
        val where = if (offline) " (saved on this device)" else ""
        return "You checked in$at$where. CHECK OUT becomes available after $mins $unit."
    }
}
