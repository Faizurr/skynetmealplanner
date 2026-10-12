package com.attendance.kiosk.core.format

import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.face.Guidance
import com.attendance.kiosk.core.liveness.LivenessPrompt

/** Employee-facing copy for the camera screen. */
object KioskText {
    fun actionTitle(a: Action) = if (a == Action.CHECK_IN) "CHECK IN" else "CHECK OUT"
    fun actionInProgress(a: Action) = if (a == Action.CHECK_IN) "Checking IN" else "Checking OUT"

    fun guidance(g: Guidance) = when (g) {
        Guidance.POSITION_FACE -> "Position your face inside the frame."
        Guidance.ONE_PERSON_ONLY -> "Only one person at a time, please."
        Guidance.COME_CLOSER -> "Come a little closer."
        Guidance.HOLD_STILL -> "Hold still…"
        Guidance.FACE_CHANGED -> "Only one person at a time, please."
    }

    fun liveness(p: LivenessPrompt) = when (p) {
        LivenessPrompt.TURN_LEFT -> "Slowly turn your head to the LEFT"
        LivenessPrompt.TURN_RIGHT -> "Slowly turn your head to the RIGHT"
        LivenessPrompt.LOOK_STRAIGHT -> "Now look straight ahead"
    }

    const val UNKNOWN_FACE =
        "We don't recognise you yet. Please ask a manager to register you, or use your staff PIN."
    const val UNKNOWN_FACE_NO_PIN = "We don't recognise you yet. Please ask a manager to register you."
}
