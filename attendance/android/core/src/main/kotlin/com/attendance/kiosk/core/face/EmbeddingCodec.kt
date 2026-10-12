package com.attendance.kiosk.core.face

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.sqrt

/**
 * Wire format shared with the server (server/src/face.ts): 128 float32 values,
 * little-endian, base64 (standard alphabet, padded), L2-normalised.
 */
object EmbeddingCodec {
    const val DIM = 128

    fun encode(v: FloatArray): String {
        require(v.size == DIM) { "embedding must have $DIM values, got ${v.size}" }
        val buf = ByteBuffer.allocate(DIM * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (x in v) buf.putFloat(x)
        return Base64.getEncoder().encodeToString(buf.array())
    }

    /** Decodes and L2-normalises, rejecting wrong sizes and non-finite values (as the server does). */
    fun decode(b64: String): FloatArray {
        val bytes = try {
            Base64.getDecoder().decode(b64.trim())
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("embedding is not valid base64", e)
        }
        require(bytes.size == DIM * 4) { "embedding must be $DIM float32 values" }
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val out = FloatArray(DIM)
        for (i in 0 until DIM) {
            val f = buf.getFloat()
            require(f.isFinite()) { "embedding contains non-finite values" }
            out[i] = f
        }
        return normalize(out)
    }

    fun normalize(v: FloatArray): FloatArray {
        var n = 0.0
        for (x in v) n += x.toDouble() * x.toDouble()
        n = sqrt(n)
        require(n > 0.0 && n.isFinite()) { "zero embedding" }
        return FloatArray(v.size) { (v[it] / n).toFloat() }
    }

    /** Dot product; equals cosine similarity for L2-normalised vectors. */
    fun cosine(a: FloatArray, b: FloatArray): Double {
        require(a.size == b.size) { "dimension mismatch" }
        var s = 0.0
        for (i in a.indices) s += a[i].toDouble() * b[i].toDouble()
        return s
    }
}
