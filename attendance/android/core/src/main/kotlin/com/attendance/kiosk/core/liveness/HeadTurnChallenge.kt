package com.attendance.kiosk.core.liveness

import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.FaceObservation
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Direction from the employee's own point of view ("turn your head to YOUR left"). */
enum class TurnDirection { LEFT, RIGHT }

enum class LivenessFailure {
    /** The sequence was not completed within the time limit. */
    TIMEOUT,
    /** A different face appeared during the challenge (embedding similarity dropped). */
    FACE_SWAPPED,
    /** The face box never moved at all — typical of a photo held still. */
    STATIC_FACE,
    /** The face left the frame for too long. */
    LOST_TRACKING,
}

/** What the employee should be told right now. */
enum class LivenessPrompt { TURN_LEFT, TURN_RIGHT, LOOK_STRAIGHT }

sealed interface LivenessState {
    /** Waiting for a usable face (the challenge clock has not started). */
    data object WaitingForFace : LivenessState
    data class InProgress(val prompt: LivenessPrompt) : LivenessState
    data object Passed : LivenessState
    data class Failed(val reason: LivenessFailure) : LivenessState
}

data class LivenessConfig(
    /** |yaw| the head must exceed in the requested direction. */
    val turnThreshold: Float = 0.18f,
    /** |yaw| below which the head counts as "looking straight". */
    val centerThreshold: Float = 0.08f,
    val timeoutMs: Long = 8_000,
    /** Every challenge frame must be at least this similar to the first one (no face swaps). */
    val minTrackingSimilarity: Double = 0.6,
    /** If x, y, w and h each vary by no more than this over the challenge, the face is "static". */
    val staticTolerancePx: Float = 1.5f,
    /** Longest allowed gap without a usable face once the challenge started. */
    val maxGapMs: Long = 1_500,
    /**
     * Whether analysed frames are horizontally mirrored. CameraX ImageAnalysis delivers the
     * front camera unmirrored (as an observer facing the employee sees them): when the employee
     * turns to THEIR left, the nose moves to the image's right, so yaw becomes positive.
     */
    val framesMirrored: Boolean = false,
)

/**
 * Software head-turn liveness challenge using YuNet landmarks. Sequence:
 * look straight → turn beyond ±[LivenessConfig.turnThreshold] in the requested direction →
 * return within ±[LivenessConfig.centerThreshold], all within [LivenessConfig.timeoutMs], with
 * continuous tracking of the same face. This raises the bar against printed photos and
 * casual replay but is NOT foolproof (e.g. a video of the employee turning their head).
 */
class HeadTurnChallenge(
    val direction: TurnDirection,
    private val config: LivenessConfig = LivenessConfig(),
) {
    private enum class Phase { AWAIT_FACE, AWAIT_CENTER, TURN, RETURN, PASSED, FAILED }

    private var phase = Phase.AWAIT_FACE
    private var startMs = 0L
    private var lastSeenMs = 0L
    private var anchor: FloatArray? = null
    private var failure: LivenessFailure? = null
    private var minX = Float.MAX_VALUE; private var maxX = -Float.MAX_VALUE
    private var minY = Float.MAX_VALUE; private var maxY = -Float.MAX_VALUE
    private var minW = Float.MAX_VALUE; private var maxW = -Float.MAX_VALUE
    private var minH = Float.MAX_VALUE; private var maxH = -Float.MAX_VALUE

    val state: LivenessState
        get() = when (phase) {
            Phase.AWAIT_FACE -> LivenessState.WaitingForFace
            Phase.AWAIT_CENTER, Phase.TURN -> LivenessState.InProgress(turnPrompt())
            Phase.RETURN -> LivenessState.InProgress(LivenessPrompt.LOOK_STRAIGHT)
            Phase.PASSED -> LivenessState.Passed
            Phase.FAILED -> LivenessState.Failed(failure ?: LivenessFailure.TIMEOUT)
        }

    val isFinished: Boolean get() = phase == Phase.PASSED || phase == Phase.FAILED

    private fun turnPrompt() = if (direction == TurnDirection.LEFT) LivenessPrompt.TURN_LEFT else LivenessPrompt.TURN_RIGHT

    /** Yaw expressed so that positive means "turned in the requested direction". */
    private fun directedYaw(face: FaceObservation): Float {
        val leftIsPositive = !config.framesMirrored
        val sign = if ((direction == TurnDirection.LEFT) == leftIsPositive) 1f else -1f
        return sign * face.yawRatio
    }

    fun onFrame(face: FaceObservation, embedding: FloatArray, nowMs: Long): LivenessState {
        if (isFinished) return state
        if (phase == Phase.AWAIT_FACE) {
            phase = Phase.AWAIT_CENTER
            startMs = nowMs
            anchor = embedding
        } else {
            if (checkTime(nowMs)) return state
            if (nowMs - lastSeenMs > config.maxGapMs) return fail(LivenessFailure.LOST_TRACKING)
            val sim = EmbeddingCodec.cosine(anchor!!, embedding)
            if (sim < config.minTrackingSimilarity) return fail(LivenessFailure.FACE_SWAPPED)
        }
        lastSeenMs = nowMs
        track(face)
        val yaw = face.yawRatio
        when (phase) {
            Phase.AWAIT_CENTER -> if (abs(yaw) <= config.centerThreshold) phase = Phase.TURN
            Phase.TURN -> if (directedYaw(face) >= config.turnThreshold) phase = Phase.RETURN
            Phase.RETURN -> if (abs(yaw) <= config.centerThreshold) {
                phase = if (isStatic()) {
                    failure = LivenessFailure.STATIC_FACE
                    Phase.FAILED
                } else {
                    Phase.PASSED
                }
            }
            else -> Unit
        }
        return state
    }

    /** Call regularly (also when no face is visible) so timeouts and tracking gaps are enforced. */
    fun onTick(nowMs: Long): LivenessState {
        if (isFinished || phase == Phase.AWAIT_FACE) return state
        if (checkTime(nowMs)) return state
        if (nowMs - lastSeenMs > config.maxGapMs) return fail(LivenessFailure.LOST_TRACKING)
        return state
    }

    private fun checkTime(nowMs: Long): Boolean {
        if (nowMs - startMs > config.timeoutMs) {
            fail(LivenessFailure.TIMEOUT)
            return true
        }
        return false
    }

    private fun fail(reason: LivenessFailure): LivenessState {
        failure = reason
        phase = Phase.FAILED
        return state
    }

    private fun track(f: FaceObservation) {
        minX = min(minX, f.x); maxX = max(maxX, f.x)
        minY = min(minY, f.y); maxY = max(maxY, f.y)
        minW = min(minW, f.w); maxW = max(maxW, f.w)
        minH = min(minH, f.h); maxH = max(maxH, f.h)
    }

    private fun isStatic(): Boolean {
        val t = config.staticTolerancePx
        return maxX - minX <= t && maxY - minY <= t && maxW - minW <= t && maxH - minH <= t
    }
}
