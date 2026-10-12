package com.attendance.kiosk.core.face

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * One YuNet detection in frame pixel coordinates. YuNet output row layout (15 floats):
 * [x, y, w, h, rightEyeX, rightEyeY, leftEyeX, leftEyeY, noseX, noseY,
 *  rightMouthX, rightMouthY, leftMouthX, leftMouthY, score].
 * "Right"/"left" are the subject's own eyes (the right eye appears on the image's left side
 * in an unmirrored frame).
 */
data class FaceObservation(
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
    val rightEyeX: Float,
    val rightEyeY: Float,
    val leftEyeX: Float,
    val leftEyeY: Float,
    val noseX: Float,
    val noseY: Float,
    val score: Float,
) {
    val shorterSide: Float get() = min(w, h)
    val area: Float get() = w * h

    /**
     * Head-yaw proxy, identical to `yaw_ratio()` in tools/face-eval/eval.py:
     * (noseX − eyeMidX) / eyeDistance. ≈0 when looking straight at the camera.
     */
    val yawRatio: Float
        get() {
            val eyeMid = (rightEyeX + leftEyeX) / 2f
            val eyeDist = max(1f, abs(leftEyeX - rightEyeX))
            return (noseX - eyeMid) / eyeDist
        }

    companion object {
        const val ROW_LENGTH = 15

        /** Builds an observation from one YuNet output row. */
        fun fromYuNetRow(r: FloatArray): FaceObservation {
            require(r.size >= ROW_LENGTH) { "YuNet row must have $ROW_LENGTH values" }
            return FaceObservation(
                x = r[0], y = r[1], w = r[2], h = r[3],
                rightEyeX = r[4], rightEyeY = r[5], leftEyeX = r[6], leftEyeY = r[7],
                noseX = r[8], noseY = r[9], score = r[14],
            )
        }
    }
}

/** Why a frame cannot be used yet; drives the on-screen guidance. */
enum class Guidance {
    /** No face: "Position your face inside the frame." */
    POSITION_FACE,
    /** More than one face: "Only one person at a time, please." */
    ONE_PERSON_ONLY,
    /** Face smaller than the minimum: "Come a little closer." */
    COME_CLOSER,
    /** Face usable; keep still while we recognise. */
    HOLD_STILL,
    /** The tracked face changed mid-attempt; start over. */
    FACE_CHANGED,
}

sealed interface FrameGateResult {
    data class Usable(val face: FaceObservation) : FrameGateResult
    data class Rejected(val guidance: Guidance) : FrameGateResult
}

/** Applies the single-face and minimum-size rules to a frame's detections. */
object FrameGate {
    fun check(faces: List<FaceObservation>, minFacePx: Float, minScore: Float = 0f): FrameGateResult {
        val confident = faces.filter { it.score >= minScore }
        return when {
            confident.isEmpty() -> FrameGateResult.Rejected(Guidance.POSITION_FACE)
            confident.size > 1 -> FrameGateResult.Rejected(Guidance.ONE_PERSON_ONLY)
            confident[0].shorterSide < minFacePx -> FrameGateResult.Rejected(Guidance.COME_CLOSER)
            else -> FrameGateResult.Usable(confident[0])
        }
    }
}
