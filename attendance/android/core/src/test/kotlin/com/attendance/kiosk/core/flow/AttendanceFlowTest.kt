package com.attendance.kiosk.core.flow

import com.attendance.kiosk.core.FakeClock
import com.attendance.kiosk.core.Vectors
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.AttendanceEvent
import com.attendance.kiosk.core.api.AttendanceResult
import com.attendance.kiosk.core.api.DisplayDto
import com.attendance.kiosk.core.api.EmployeeRef
import com.attendance.kiosk.core.api.ErrorBody
import com.attendance.kiosk.core.api.KioskSettings
import com.attendance.kiosk.core.api.Method
import com.attendance.kiosk.core.face.AcceptedCandidate
import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.Guidance
import com.attendance.kiosk.core.face.RecognitionUpdate
import com.attendance.kiosk.core.liveness.LivenessFailure
import com.attendance.kiosk.core.liveness.LivenessPrompt
import com.attendance.kiosk.core.queue.QueueEntry
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.IOException
import java.time.Instant
import kotlin.random.Random
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AttendanceFlowTest {
    private val clock = FakeClock(Instant.parse("2026-10-12T01:02:00Z").toEpochMilli()) // 9:02 am in Kuala Lumpur
    private val lastActions = InMemoryLastActionStore()
    private val queued = mutableListOf<QueueEntry>()
    private var sinkWorks = true
    private val states = mutableListOf<FlowState>()
    private var ids = 0
    private lateinit var flow: AttendanceFlow

    private val sarahId = "11111111-1111-4111-8111-111111111111"
    private val embedding = Vectors.random(Random(5))

    @BeforeTest
    fun setUp() {
        flow = AttendanceFlow(
            clock = clock,
            lastActions = lastActions,
            offlineSink = { e -> if (sinkWorks) queued.add(e) else false },
            newEventId = { "00000000-0000-4000-8000-00000000000${++ids}" },
            onState = { states += it },
        )
        flow.updateSettings(KioskSettings(), "Asia/Kuala_Lumpur")
    }

    private fun candidate(liveness: Boolean = true) =
        AcceptedCandidate(sarahId, "Sarah", "Sarah Lim", 0.83, embedding, liveness)

    private fun accept(eventId: String, liveness: Boolean = true): FlowEffect.Submit {
        val effects = flow.onRecognition(eventId, RecognitionUpdate.Accepted(candidate(liveness)))
        return assertIs<FlowEffect.Submit>(effects.single())
    }

    private fun okResult(action: Action, pending: Boolean = false) = ApiResult.Ok(
        AttendanceResult(
            result = if (pending) "pending_review" else "recorded",
            event = AttendanceEvent("e", action, "2026-10-12T01:02:05.000Z", if (pending) "pending_review" else "verified"),
            employee = EmployeeRef(sarahId, "Sarah Lim", "Sarah", "S001"),
            display = DisplayDto(
                "Good morning, Sarah!",
                if (pending) "RECORDED — AWAITING MANAGER REVIEW" else if (action == Action.CHECK_IN) "CHECK-IN SUCCESSFUL" else "CHECK-OUT SUCCESSFUL",
                "9:02 am", "12 October 2026", if (action == Action.CHECK_OUT) "9h 06m" else null, "Have a great shift!",
            ),
        ),
    )

    private fun http(status: Int, code: String, message: String? = null, checkInAt: String? = null) = ApiResult.Http(
        status,
        ErrorBody(code, message, checkInAt?.let { buildJsonObject { put("check_in_at", JsonPrimitive(it)) } }),
    )

    // --- Taps & button lock --------------------------------------------------------------

    @Test
    fun `tap creates one attempt with a fresh event id and opens the camera for that action`() {
        val a = assertNotNull(flow.tapAction(Action.CHECK_IN))
        assertEquals(Action.CHECK_IN, a.action)
        val cam = assertIs<FlowState.Camera>(flow.state)
        assertEquals(a, cam.attempt)
        assertEquals(clock.now + 20_000, cam.deadlineMs)
    }

    @Test
    fun `repeated taps produce exactly one attempt (buttons locked)`() {
        val first = flow.tapAction(Action.CHECK_IN)
        assertNotNull(first)
        assertNull(flow.tapAction(Action.CHECK_IN))
        assertNull(flow.tapAction(Action.CHECK_OUT))
        assertEquals(1, ids)
        assertEquals(first, (flow.state as FlowState.Camera).attempt)
    }

    // --- Cancel ------------------------------------------------------------------------------

    @Test
    fun `cancel returns home and a later recognition result submits nothing`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        assertTrue(flow.cancel())
        assertEquals(FlowState.Home, flow.state)
        assertFalse(flow.isCameraActive(a.eventId))
        val effects = flow.onRecognition(a.eventId, RecognitionUpdate.Accepted(candidate()))
        assertTrue(effects.isEmpty())
        assertEquals(FlowState.Home, flow.state)
    }

    @Test
    fun `cancel is not possible once the request is in flight`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        assertFalse(flow.cancel())
        assertIs<FlowState.Submitting>(flow.state)
    }

    @Test
    fun `stale results from an older attempt are ignored`() {
        val old = flow.tapAction(Action.CHECK_IN)!!
        flow.cancel()
        val now = flow.tapAction(Action.CHECK_OUT)!!
        assertTrue(flow.onRecognition(old.eventId, RecognitionUpdate.Accepted(candidate())).isEmpty())
        assertTrue(flow.onSubmitResult(old.eventId, okResult(Action.CHECK_IN)).isEmpty())
        assertEquals(now, (flow.state as FlowState.Camera).attempt)
    }

    // --- Submission -----------------------------------------------------------------------

    @Test
    fun `acceptance submits exactly once with the tapped action and attempt event id`() {
        val a = flow.tapAction(Action.CHECK_OUT)!!
        val submit = accept(a.eventId)
        val r = submit.request
        assertEquals(a.eventId, r.eventId)
        assertEquals(Action.CHECK_OUT, r.action)
        assertEquals(Method.FACE, r.method)
        assertEquals(sarahId, r.employeeId)
        assertEquals(EmbeddingCodec.encode(embedding), r.embedding)
        assertEquals(0.83, r.matchScore)
        assertEquals(true, r.livenessPassed)
        assertFalse(r.offline)
        assertEquals("2026-10-12T01:02:00Z", r.deviceTimestamp)
        // A second acceptance for the same attempt produces nothing.
        assertTrue(flow.onRecognition(a.eventId, RecognitionUpdate.Accepted(candidate())).isEmpty())
    }

    @Test
    fun `progress updates guidance and liveness prompt`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        flow.onRecognition(a.eventId, RecognitionUpdate.Progress(Guidance.COME_CLOSER, LivenessPrompt.TURN_LEFT, 2))
        val cam = assertIs<FlowState.Camera>(flow.state)
        assertEquals(Guidance.COME_CLOSER, cam.guidance)
        assertEquals(LivenessPrompt.TURN_LEFT, cam.livenessPrompt)
        assertEquals(2, cam.agreeingFrames)
    }

    @Test
    fun `200 shows the server's verified result and records the last action`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        val effects = flow.onSubmitResult(a.eventId, okResult(Action.CHECK_IN))
        assertEquals(listOf<FlowEffect>(FlowEffect.PlaySuccess(true)), effects)
        val s = assertIs<FlowState.Success>(flow.state)
        assertEquals("CHECK-IN SUCCESSFUL", s.view.headline)
        assertEquals("Good morning, Sarah!", s.view.greeting)
        assertEquals("9:02 am", s.view.time)
        assertFalse(s.view.provisional)
        assertFalse(s.view.pendingReview)
        assertEquals(4, s.view.returnSeconds)
        assertEquals(Action.CHECK_IN, lastActions.get(sarahId)?.action)
    }

    @Test
    fun `pending review is reported honestly`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, okResult(Action.CHECK_IN, pending = true))
        assertTrue(assertIs<FlowState.Success>(flow.state).view.pendingReview)
    }

    @Test
    fun `sound respects settings and the local override`() {
        flow.updateSettings(KioskSettings(soundEnabled = false), "Asia/Kuala_Lumpur")
        var a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        assertEquals(listOf<FlowEffect>(FlowEffect.PlaySuccess(false)), flow.onSubmitResult(a.eventId, okResult(Action.CHECK_IN)))
        flow.backHome()
        flow.updateSettings(KioskSettings(soundEnabled = true), "Asia/Kuala_Lumpur", soundOverride = false)
        a = flow.tapAction(Action.CHECK_OUT)!!
        accept(a.eventId)
        assertEquals(listOf<FlowEffect>(FlowEffect.PlaySuccess(false)), flow.onSubmitResult(a.eventId, okResult(Action.CHECK_OUT)))
    }

    // --- Wrong action: explained, never switched ----------------------------------------

    @Test
    fun `already checked in shows the wrong-action screen and never switches the action`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        val effects = flow.onSubmitResult(a.eventId, http(409, "already_checked_in", "You are already checked in since 9:02 am.", "2026-10-12T01:02:00.000Z"))
        assertTrue(effects.isEmpty(), "no automatic CHECK OUT submission")
        val w = assertIs<FlowState.WrongAction>(flow.state)
        assertEquals("You're already checked in since 9:02 am. Did you mean CHECK OUT?", w.message)
        assertEquals(Action.CHECK_IN, w.attempt.action)
        assertTrue(flow.backHome())
        assertEquals(FlowState.Home, flow.state)
        assertFalse(states.any { it is FlowState.Submitting && it.attempt.action == Action.CHECK_OUT })
    }

    @Test
    fun `no active session on check out`() {
        val a = flow.tapAction(Action.CHECK_OUT)!!
        accept(a.eventId)
        assertTrue(flow.onSubmitResult(a.eventId, http(409, "no_active_session")).isEmpty())
        val w = assertIs<FlowState.WrongAction>(flow.state)
        assertTrue(w.message.contains("Did you mean CHECK IN?"))
        assertEquals(Action.CHECK_OUT, w.attempt.action)
    }

    @Test
    fun `too soon after check in`() {
        val a = flow.tapAction(Action.CHECK_OUT)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, http(409, "too_soon", checkInAt = "2026-10-12T01:01:40.000Z"))
        val w = assertIs<FlowState.WrongAction>(flow.state)
        assertEquals("You checked in at 9:01 am. CHECK OUT becomes available after 1 minute.", w.message)
    }

    // --- Rejections ---------------------------------------------------------------------------

    @Test
    fun `server not recognised leads to retry with the same event id`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, http(422, "not_recognized", "Face not recognised."))
        val f = assertIs<FlowState.Failure>(flow.state)
        assertEquals(FailureKind.NOT_RECOGNIZED, f.kind)
        assertTrue(f.canRetry); assertTrue(f.canUsePin)
        assertTrue(flow.retry())
        val cam = assertIs<FlowState.Camera>(flow.state)
        assertEquals(a.eventId, cam.attempt.eventId)
        assertEquals(1, cam.failures)
        assertEquals(a.eventId, accept(a.eventId).request.eventId)
    }

    @Test
    fun `inactive employee is told to see a manager without retry`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, http(403, "employee_inactive"))
        val f = assertIs<FlowState.Failure>(flow.state)
        assertEquals(FailureKind.EMPLOYEE_INACTIVE, f.kind)
        assertFalse(f.canRetry)
        assertFalse(flow.retry())
    }

    @Test
    fun `revoked device goes to pairing`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        val effects = flow.onSubmitResult(a.eventId, http(401, "device_revoked"))
        assertEquals(listOf<FlowEffect>(FlowEffect.DeviceRevoked), effects)
        assertEquals(FlowState.DeviceRevoked, flow.state)
        assertNull(flow.tapAction(Action.CHECK_IN))
    }

    // --- Unknown face / timeout / liveness --------------------------------------------------

    @Test
    fun `unknown face shows the message and reports to the server, never guesses`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        val effects = flow.onRecognition(a.eventId, RecognitionUpdate.Unknown(0.41))
        assertEquals(listOf<FlowEffect>(FlowEffect.ReportUnknownFace(Action.CHECK_IN, 0.41)), effects)
        val u = assertIs<FlowState.UnknownFace>(flow.state)
        assertTrue(u.canUsePin)
        assertFalse(states.any { it is FlowState.Submitting })
    }

    @Test
    fun `camera timeout without a face gives retry, PIN and cancel`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        assertFalse(flow.isCameraExpired(a.eventId))
        clock.advance(20_000)
        assertTrue(flow.isCameraExpired(a.eventId))
        flow.onRecognition(a.eventId, RecognitionUpdate.NoFaceTimeout)
        val f = assertIs<FlowState.Failure>(flow.state)
        assertEquals(FailureKind.TIMEOUT, f.kind)
        assertTrue(f.canRetry && f.canUsePin)
        assertTrue(flow.cancel())
        assertEquals(FlowState.Home, flow.state)
    }

    @Test
    fun `liveness failure offers retry`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        flow.onRecognition(a.eventId, RecognitionUpdate.LivenessFailed(LivenessFailure.TIMEOUT))
        assertEquals(FailureKind.LIVENESS, assertIs<FlowState.Failure>(flow.state).kind)
        assertTrue(flow.retry())
    }

    @Test
    fun `camera error and permission denial`() {
        var a = flow.tapAction(Action.CHECK_IN)!!
        flow.onCameraError(a.eventId, permissionDenied = true, message = "Allow camera access in Settings")
        assertEquals(FailureKind.CAMERA_PERMISSION, assertIs<FlowState.Failure>(flow.state).kind)
        flow.cancel()
        a = flow.tapAction(Action.CHECK_IN)!!
        flow.onCameraError(a.eventId, permissionDenied = false, message = "Camera in use")
        val f = assertIs<FlowState.Failure>(flow.state)
        assertEquals(FailureKind.CAMERA, f.kind)
        assertTrue(f.canUsePin)
    }

    // --- Offline ------------------------------------------------------------------------------

    @Test
    fun `network failure with offline mode queues and shows a provisional success with device time`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        val effects = flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("timeout")))
        assertEquals(listOf<FlowEffect>(FlowEffect.PlaySuccess(true)), effects)
        val s = assertIs<FlowState.Success>(flow.state)
        assertTrue(s.view.provisional)
        assertEquals("9:02 am", s.view.time)
        assertTrue(s.view.message.contains("Saved on this device"))
        assertFalse(s.view.message.contains("notified", ignoreCase = true))
        val e = queued.single()
        assertEquals(a.eventId, e.eventId)
        assertEquals(Action.CHECK_IN, e.action)
        assertEquals(sarahId, e.employeeId)
        assertEquals(EmbeddingCodec.encode(embedding), e.embedding)
        assertTrue(e.livenessPassed)
        assertTrue(e.toRequest().offline)
        assertEquals(clock.now, e.deviceTimeMs)
        assertEquals(Action.CHECK_IN, lastActions.get(sarahId)?.action)
    }

    @Test
    fun `5xx is treated like the server being unreachable`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, http(503, "unavailable"))
        assertTrue(assertIs<FlowState.Success>(flow.state).view.provisional)
        assertEquals(1, queued.size)
    }

    @Test
    fun `offline wrong action is caught by the local last-action guard`() {
        lastActions.put(sarahId, LastAction(Action.CHECK_IN, clock.now - 3_600_000))
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("offline")))
        val w = assertIs<FlowState.WrongAction>(flow.state)
        assertEquals("You're already checked in since 8:02 am (saved on this device). Did you mean CHECK OUT?", w.message)
        assertTrue(queued.isEmpty())
    }

    @Test
    fun `offline disabled - nothing is saved and the employee is told it was not recorded`() {
        flow.updateSettings(KioskSettings(offlineModeEnabled = false), "Asia/Kuala_Lumpur")
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("offline")))
        val f = assertIs<FlowState.Failure>(flow.state)
        assertEquals(FailureKind.NETWORK, f.kind)
        assertTrue(f.message.contains("NOT recorded"))
        assertTrue(queued.isEmpty())
    }

    @Test
    fun `offline save requires liveness when liveness is required`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId, liveness = false)
        flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("offline")))
        assertIs<FlowState.Failure>(flow.state)
        assertTrue(queued.isEmpty())
    }

    @Test
    fun `offline save allowed without liveness when not required`() {
        flow.updateSettings(KioskSettings(livenessRequired = false), "Asia/Kuala_Lumpur")
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId, liveness = false)
        flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("offline")))
        assertIs<FlowState.Success>(flow.state)
        assertEquals(1, queued.size)
    }

    @Test
    fun `failure to persist offline is not shown as success`() {
        sinkWorks = false
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, ApiResult.Network(IOException("offline")))
        assertIs<FlowState.Failure>(flow.state)
        assertNull(lastActions.get(sarahId))
    }

    // --- PIN --------------------------------------------------------------------------------

    @Test
    fun `PIN from home asks for the action and creates the event id at that tap`() {
        assertTrue(flow.openPinFromHome())
        val p = assertIs<FlowState.PinEntry>(flow.state)
        assertNull(p.action); assertNull(p.attempt)
        assertNull(flow.submitPin("S001", "1234"), "cannot submit before choosing the action")
        assertTrue(flow.choosePinAction(Action.CHECK_OUT))
        val p2 = assertIs<FlowState.PinEntry>(flow.state)
        assertEquals(Action.CHECK_OUT, p2.action)
        val submit = assertNotNull(flow.submitPin(" S001 ", "1234"))
        assertEquals(Method.PIN, submit.request.method)
        assertEquals(Action.CHECK_OUT, submit.request.action)
        assertEquals("S001", submit.request.staffId)
        assertEquals("1234", submit.request.pin)
        assertNull(submit.request.embedding)
        assertEquals(p2.attempt!!.eventId, submit.request.eventId)
    }

    @Test
    fun `PIN from the camera keeps the chosen action and event id`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        assertTrue(flow.openPinForAttempt())
        val p = assertIs<FlowState.PinEntry>(flow.state)
        assertEquals(Action.CHECK_IN, p.action)
        assertFalse(flow.choosePinAction(Action.CHECK_OUT), "action cannot be changed on the PIN screen")
        val submit = assertNotNull(flow.submitPin("S001", "123456"))
        assertEquals(a.eventId, submit.request.eventId)
        assertEquals(Action.CHECK_IN, submit.request.action)
    }

    @Test
    fun `PIN validation errors stay on the keypad`() {
        flow.tapAction(Action.CHECK_IN)
        flow.openPinForAttempt()
        assertNull(flow.submitPin("S001", "12"))
        assertEquals("Your PIN is 4 to 8 digits.", assertIs<FlowState.PinEntry>(flow.state).error)
        assertNull(flow.submitPin("", "1234"))
        assertEquals("Enter your staff ID.", assertIs<FlowState.PinEntry>(flow.state).error)
        assertNull(flow.submitPin("S001", "123456789"))
        assertNull(flow.submitPin("S001", "12a4"))
    }

    @Test
    fun `wrong PIN returns to the keypad with the server message`() {
        flow.tapAction(Action.CHECK_IN)
        flow.openPinForAttempt()
        val s = flow.submitPin("S001", "1234")!!
        flow.onSubmitResult(s.eventId, http(401, "invalid_pin", "Staff ID or PIN is incorrect."))
        assertEquals("Staff ID or PIN is incorrect.", assertIs<FlowState.PinEntry>(flow.state).error)
    }

    @Test
    fun `PINs are never queued offline`() {
        flow.tapAction(Action.CHECK_IN)
        flow.openPinForAttempt()
        val s = flow.submitPin("S001", "1234")!!
        flow.onSubmitResult(s.eventId, ApiResult.Network(IOException("offline")))
        assertEquals(FailureKind.PIN_NEEDS_ONLINE, assertIs<FlowState.Failure>(flow.state).kind)
        assertTrue(queued.isEmpty())
    }

    @Test
    fun `PIN locked and PIN disabled`() {
        flow.tapAction(Action.CHECK_IN); flow.openPinForAttempt()
        var s = flow.submitPin("S001", "1234")!!
        flow.onSubmitResult(s.eventId, http(423, "pin_locked", "Too many incorrect PIN attempts."))
        assertEquals(FailureKind.PIN_LOCKED, assertIs<FlowState.Failure>(flow.state).kind)
        flow.backHome()
        flow.openPinFromHome(); flow.choosePinAction(Action.CHECK_IN)
        s = flow.submitPin("S001", "1234")!!
        flow.onSubmitResult(s.eventId, http(403, "pin_disabled"))
        assertEquals(FailureKind.PIN_DISABLED, assertIs<FlowState.Failure>(flow.state).kind)
    }

    @Test
    fun `PIN links are unavailable when PIN fallback is disabled`() {
        flow.updateSettings(KioskSettings(pinFallbackEnabled = false), "Asia/Kuala_Lumpur")
        assertFalse(flow.openPinFromHome())
        val a = flow.tapAction(Action.CHECK_IN)!!
        assertFalse(flow.openPinForAttempt())
        flow.onRecognition(a.eventId, RecognitionUpdate.Unknown(null))
        assertFalse(assertIs<FlowState.UnknownFace>(flow.state).canUsePin)
    }

    @Test
    fun `back home from result screens`() {
        val a = flow.tapAction(Action.CHECK_IN)!!
        accept(a.eventId)
        flow.onSubmitResult(a.eventId, okResult(Action.CHECK_IN))
        assertTrue(flow.backHome())
        assertEquals(FlowState.Home, flow.state)
        assertNotNull(flow.tapAction(Action.CHECK_OUT), "buttons unlock again on home")
    }
}
