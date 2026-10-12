package com.attendance.kiosk.core

import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.FaceObservation
import com.attendance.kiosk.core.face.TemplateSet
import kotlin.random.Random

object Vectors {
    fun random(rng: Random): FloatArray = EmbeddingCodec.normalize(FloatArray(EmbeddingCodec.DIM) { rng.nextGaussian() })

    /** A vector with cosine ≈ [similarity] to [base] (exact up to float rounding). */
    fun withSimilarity(base: FloatArray, similarity: Double, rng: Random): FloatArray {
        val b = EmbeddingCodec.normalize(base)
        val r = random(rng)
        val dot = EmbeddingCodec.cosine(b, r)
        val ortho = EmbeddingCodec.normalize(FloatArray(b.size) { (r[it] - dot * b[it]).toFloat() })
        val s = similarity
        val c = kotlin.math.sqrt(maxOf(0.0, 1 - s * s))
        return EmbeddingCodec.normalize(FloatArray(b.size) { (s * b[it] + c * ortho[it]).toFloat() })
    }

    private fun Random.nextGaussian(): Float {
        val u1 = nextDouble().coerceAtLeast(1e-12)
        val u2 = nextDouble()
        return (kotlin.math.sqrt(-2 * kotlin.math.ln(u1)) * kotlin.math.cos(2 * Math.PI * u2)).toFloat()
    }
}

/** Builds a frontal face with configurable yaw (nose offset as a fraction of eye distance). */
fun face(
    x: Float = 200f,
    y: Float = 150f,
    size: Float = 160f,
    yaw: Float = 0f,
    score: Float = 0.95f,
): FaceObservation {
    val eyeY = y + size * 0.4f
    val rightEyeX = x + size * 0.3f
    val leftEyeX = x + size * 0.7f
    val eyeDist = leftEyeX - rightEyeX
    val noseX = (rightEyeX + leftEyeX) / 2f + yaw * eyeDist
    return FaceObservation(x, y, size, size, rightEyeX, eyeY, leftEyeX, eyeY, noseX, y + size * 0.6f, score)
}

fun templateSet(id: String, name: String, vararg vectors: FloatArray) =
    TemplateSet(id, name.substringBefore(' '), name, "S-$id", vectors.toList())

class FakeClock(var now: Long = 1_760_000_000_000L) : () -> Long {
    override fun invoke(): Long = now
    fun advance(ms: Long) { now += ms }
}
