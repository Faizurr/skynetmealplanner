package com.attendance.kiosk.core.face

import com.attendance.kiosk.core.liveness.HeadTurnChallenge
import com.attendance.kiosk.core.liveness.LivenessFailure
import com.attendance.kiosk.core.liveness.LivenessPrompt
import com.attendance.kiosk.core.liveness.LivenessState
import kotlin.math.abs

data class RecognitionConfig(
    /** YuNet confidence threshold (also configured on the detector). */
    val detectionScore: Float = 0.8f,
    /** Faces whose shorter side is below this many pixels are "too far away". */
    val minFacePx: Float = 80f,
    /** Consecutive agreeing frames required before a match is accepted. */
    val requiredConsecutive: Int = 3,
    /** Frames this similar to the previous processed frame are skipped as duplicates. */
    val duplicateCosine: Double = 0.995,
    /** Below this similarity to the first face of the attempt we consider it a different person. */
    val trackingSimilarity: Double = 0.6,
    /** Frames turned further than this (|yaw|) are ignored for matching during a head turn. */
    val maxYawForMatching: Float = 0.12f,
    /** After this many usable frames without a single accepted match, report an unknown face. */
    val unknownAfterFrames: Int = 24,
    /** Minimum usable frames before a timeout is reported as "unknown face" rather than "no face". */
    val minFramesForUnknown: Int = 3,
)

data class AcceptedCandidate(
    val employeeId: String,
    val displayName: String,
    val fullName: String,
    val score: Double,
    /** Embedding of the best frame (highest score) in the agreeing streak. */
    val embedding: FloatArray,
    val livenessPassed: Boolean,
) {
    override fun equals(other: Any?): Boolean =
        other is AcceptedCandidate && other.employeeId == employeeId && other.score == score &&
            other.livenessPassed == livenessPassed && other.embedding.contentEquals(embedding)

    override fun hashCode(): Int = employeeId.hashCode() * 31 + score.hashCode()
}

sealed interface RecognitionUpdate {
    data class Progress(
        val guidance: Guidance,
        val livenessPrompt: LivenessPrompt?,
        /** Agreeing frames so far (0..requiredConsecutive), for a progress indicator. */
        val agreeingFrames: Int,
    ) : RecognitionUpdate

    data class Accepted(val candidate: AcceptedCandidate) : RecognitionUpdate
    data class LivenessFailed(val reason: LivenessFailure) : RecognitionUpdate
    data class Unknown(val bestScore: Double?) : RecognitionUpdate

    /** The attempt timed out without ever seeing a usable face. */
    data object NoFaceTimeout : RecognitionUpdate
}

/** Result of the detection step: either we need an embedding of [face], or the frame is done. */
sealed interface DetectionStep {
    data class NeedEmbedding(val face: FaceObservation) : DetectionStep
    data class Done(val update: RecognitionUpdate) : DetectionStep
}

/**
 * Per-attempt recognition: frame gating, duplicate skipping, 1:N matching, N-frame consensus,
 * face tracking and the optional liveness challenge. One instance per camera attempt; after it
 * returns a terminal update (Accepted / LivenessFailed / Unknown) it ignores further frames,
 * so a match is accepted — and therefore submitted — at most once.
 *
 * Not thread-safe: feed it from the single analysis thread.
 */
class RecognitionSession(
    private val templates: List<TemplateSet>,
    private val threshold: Double,
    private val margin: Double,
    private val challenge: HeadTurnChallenge?,
    private val config: RecognitionConfig = RecognitionConfig(),
) {
    private var terminal: RecognitionUpdate? = null
    private var anchor: FloatArray? = null
    private var previous: FloatArray? = null
    private var streakEmployee: String? = null
    private var streak = 0
    private var streakBest: Pair<Double, FloatArray>? = null
    private var lastGuidance = Guidance.POSITION_FACE

    /** Usable (single, large enough) frames that produced an embedding and were matched. */
    var matchedFrames: Int = 0
        private set

    /** Best 1:N score seen in this attempt (for the unknown-face report). */
    var bestScore: Double? = null
        private set
    private var anyAccepted = false

    val isFinished: Boolean get() = terminal != null
    val livenessRequired: Boolean get() = challenge != null

    fun onDetections(faces: List<FaceObservation>, nowMs: Long): DetectionStep {
        terminal?.let { return DetectionStep.Done(it) }
        return when (val g = FrameGate.check(faces, config.minFacePx, config.detectionScore)) {
            is FrameGateResult.Usable -> DetectionStep.NeedEmbedding(g.face)
            is FrameGateResult.Rejected -> {
                if (g.guidance == Guidance.ONE_PERSON_ONLY) resetStreak()
                lastGuidance = g.guidance
                DetectionStep.Done(tick(nowMs) ?: progress(g.guidance))
            }
        }
    }

    fun onEmbedding(face: FaceObservation, rawEmbedding: FloatArray, nowMs: Long): RecognitionUpdate {
        terminal?.let { return it }
        val embedding = EmbeddingCodec.normalize(rawEmbedding)

        // 1. Continuous tracking of one face for the whole attempt.
        val a = anchor
        if (a == null) {
            anchor = embedding
        } else if (EmbeddingCodec.cosine(a, embedding) < config.trackingSimilarity) {
            if (challenge != null) return finish(RecognitionUpdate.LivenessFailed(LivenessFailure.FACE_SWAPPED))
            anchor = embedding
            previous = null
            resetStreak()
            lastGuidance = Guidance.FACE_CHANGED
            return progress(Guidance.FACE_CHANGED)
        }

        // 2. Liveness challenge sees every usable frame.
        val liveness = challenge?.onFrame(face, embedding, nowMs)
        if (liveness is LivenessState.Failed) return finish(RecognitionUpdate.LivenessFailed(liveness.reason))

        // 3. Turned-away frames are not used for matching.
        if (challenge != null && abs(face.yawRatio) > config.maxYawForMatching) {
            return progress(Guidance.HOLD_STILL)
        }

        // 4. Near-identical consecutive frames add no information.
        val prev = previous
        previous = embedding
        if (prev != null && EmbeddingCodec.cosine(prev, embedding) > config.duplicateCosine) {
            return maybeAccept() ?: progress(Guidance.HOLD_STILL)
        }

        // 5. 1:N match and consensus.
        val m = Matcher.identify(embedding, templates, threshold, margin)
        matchedFrames++
        if (m.employeeId != null) bestScore = maxOf(bestScore ?: -1.0, m.score)
        if (m.accepted && m.employeeId != null) {
            anyAccepted = true
            if (m.employeeId == streakEmployee) {
                streak++
            } else {
                streakEmployee = m.employeeId
                streak = 1
                streakBest = null
            }
            val sb = streakBest
            if (sb == null || m.score > sb.first) streakBest = m.score to embedding
        } else {
            resetStreak()
        }
        lastGuidance = Guidance.HOLD_STILL
        maybeAccept()?.let { return it }
        if (!anyAccepted && matchedFrames >= config.unknownAfterFrames) {
            return finish(RecognitionUpdate.Unknown(bestScore))
        }
        return progress(Guidance.HOLD_STILL)
    }

    /** Call periodically (e.g. on every analysed frame) to enforce the liveness timeout. */
    fun tick(nowMs: Long): RecognitionUpdate? {
        terminal?.let { return it }
        val s = challenge?.onTick(nowMs)
        if (s is LivenessState.Failed) return finish(RecognitionUpdate.LivenessFailed(s.reason))
        return null
    }

    /** Called when the overall attempt time runs out. */
    fun onAttemptTimeout(): RecognitionUpdate {
        terminal?.let { return it }
        return finish(
            if (matchedFrames >= config.minFramesForUnknown) {
                RecognitionUpdate.Unknown(bestScore)
            } else {
                RecognitionUpdate.NoFaceTimeout
            },
        )
    }

    private fun maybeAccept(): RecognitionUpdate? {
        val id = streakEmployee ?: return null
        if (streak < config.requiredConsecutive) return null
        val livenessOk = challenge == null || challenge.state == LivenessState.Passed
        if (!livenessOk) return null
        val set = templates.firstOrNull { it.employeeId == id } ?: return null
        val best = streakBest ?: return null
        return finish(
            RecognitionUpdate.Accepted(
                AcceptedCandidate(
                    employeeId = id,
                    displayName = set.displayName,
                    fullName = set.fullName,
                    score = best.first,
                    embedding = best.second,
                    livenessPassed = challenge != null,
                ),
            ),
        )
    }

    private fun progress(g: Guidance): RecognitionUpdate.Progress {
        val prompt = when (val s = challenge?.state) {
            is LivenessState.InProgress -> s.prompt
            else -> null
        }
        return RecognitionUpdate.Progress(g, prompt, streak.coerceAtMost(config.requiredConsecutive))
    }

    private fun resetStreak() {
        streakEmployee = null
        streak = 0
        streakBest = null
    }

    private fun finish(u: RecognitionUpdate): RecognitionUpdate {
        terminal = u
        return u
    }
}
