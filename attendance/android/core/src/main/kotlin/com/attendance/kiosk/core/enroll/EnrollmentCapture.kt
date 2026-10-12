package com.attendance.kiosk.core.enroll

import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.FaceObservation
import com.attendance.kiosk.core.face.FrameGate
import com.attendance.kiosk.core.face.FrameGateResult
import com.attendance.kiosk.core.face.Guidance

enum class EnrollPose(val instruction: String) {
    STRAIGHT("Look straight at the camera"),
    LEFT("Turn your head slightly to the left"),
    RIGHT("Turn your head slightly to the right"),
    CLOSER("Move a little closer to the screen"),
    NORMAL("Back to normal distance, look straight ahead"),
}

enum class SampleIssue(val message: String) {
    NO_FACE("No face found. Ask the employee to face the screen."),
    MULTIPLE_FACES("More than one face is visible. Only the employee should be in frame."),
    TOO_SMALL("The face is too small. Ask the employee to come closer."),
    BLURRY("The image is blurry. Hold still, improve the lighting and try again."),
    DIFFERENT_PERSON("This sample doesn't look like the earlier ones. Make sure it's the same person."),
}

sealed interface SampleCheck {
    data class Ok(val face: FaceObservation) : SampleCheck
    data class Rejected(val issue: SampleIssue) : SampleCheck
}

data class SampleQualityConfig(
    val detectionScore: Float = 0.8f,
    /** Enrollment requires larger faces than recognition (100 px vs 80 px). */
    val minFacePx: Float = 100f,
    /** Minimum variance of the Laplacian of the aligned 112×112 grey face crop. */
    val minSharpness: Double = 40.0,
    /** A new sample must be at least this similar to the first sample. */
    val minSimilarityToFirst: Double = 0.4,
)

/**
 * Guided capture of enrollment samples (five poses). Each sample must be single-face, large
 * enough and sharp. [consistencyOk] mirrors the server's `inconsistent_samples` rule so the
 * manager can redo the capture before uploading.
 */
class EnrollmentCapture(private val config: SampleQualityConfig = SampleQualityConfig()) {
    private val _samples = mutableListOf<FloatArray>()
    val samples: List<FloatArray> get() = _samples.toList()
    val poses: List<EnrollPose> = EnrollPose.entries
    val currentPose: EnrollPose? get() = poses.getOrNull(_samples.size)
    val isComplete: Boolean get() = _samples.size >= poses.size
    val count: Int get() = _samples.size

    fun checkDetections(faces: List<FaceObservation>): SampleCheck =
        when (val g = FrameGate.check(faces, config.minFacePx, config.detectionScore)) {
            is FrameGateResult.Usable -> SampleCheck.Ok(g.face)
            is FrameGateResult.Rejected -> SampleCheck.Rejected(
                when (g.guidance) {
                    Guidance.ONE_PERSON_ONLY -> SampleIssue.MULTIPLE_FACES
                    Guidance.COME_CLOSER -> SampleIssue.TOO_SMALL
                    else -> SampleIssue.NO_FACE
                },
            )
        }

    /** Checks sharpness/consistency and stores the sample if acceptable. */
    fun offer(face: FaceObservation, embedding: FloatArray, sharpness: Double): SampleCheck {
        if (isComplete) return SampleCheck.Ok(face)
        if (sharpness < config.minSharpness) return SampleCheck.Rejected(SampleIssue.BLURRY)
        val v = EmbeddingCodec.normalize(embedding)
        val first = _samples.firstOrNull()
        if (first != null && EmbeddingCodec.cosine(first, v) < config.minSimilarityToFirst) {
            return SampleCheck.Rejected(SampleIssue.DIFFERENT_PERSON)
        }
        _samples += v
        return SampleCheck.Ok(face)
    }

    fun minPairSimilarity(): Double {
        var m = 1.0
        for (i in _samples.indices) for (j in i + 1 until _samples.size) m = minOf(m, EmbeddingCodec.cosine(_samples[i], _samples[j]))
        return m
    }

    /** Same rule as the server: min pairwise similarity ≥ max(0.4, threshold − 0.05). */
    fun consistencyOk(matchThreshold: Double): Boolean = minPairSimilarity() >= maxOf(0.4, matchThreshold - 0.05)

    fun encoded(): List<String> = _samples.map(EmbeddingCodec::encode)

    fun reset() = _samples.clear()
}
