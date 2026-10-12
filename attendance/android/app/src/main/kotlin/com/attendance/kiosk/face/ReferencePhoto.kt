package com.attendance.kiosk.face

import com.attendance.kiosk.core.face.FaceObservation
import org.opencv.core.Mat
import org.opencv.core.MatOfByte
import org.opencv.core.MatOfInt
import org.opencv.core.Rect
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Builds the optional consent-gated reference photo: a face crop JPEG of at most 200 KB. */
object ReferencePhoto {
    const val MAX_BYTES = 200 * 1024

    fun encode(bgr: Mat, face: FaceObservation): ByteArray? {
        val margin = 0.45f
        val cx = face.x + face.w / 2f
        val cy = face.y + face.h / 2f
        val half = max(face.w, face.h) * (0.5f + margin)
        val x0 = max(0, (cx - half).roundToInt())
        val y0 = max(0, (cy - half).roundToInt())
        val x1 = min(bgr.cols(), (cx + half).roundToInt())
        val y1 = min(bgr.rows(), (cy + half).roundToInt())
        if (x1 - x0 < 32 || y1 - y0 < 32) return null
        val crop = Mat(bgr, Rect(x0, y0, x1 - x0, y1 - y0))
        val resized = Mat()
        try {
            val side = max(crop.cols(), crop.rows())
            val src = if (side > 480) {
                val s = 480.0 / side
                Imgproc.resize(crop, resized, Size(crop.cols() * s, crop.rows() * s), 0.0, 0.0, Imgproc.INTER_AREA)
                resized
            } else {
                crop
            }
            for (quality in intArrayOf(85, 75, 65, 55, 45)) {
                val buf = MatOfByte()
                try {
                    if (Imgcodecs.imencode(".jpg", src, buf, MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality))) {
                        val bytes = buf.toArray()
                        if (bytes.size <= MAX_BYTES) return bytes
                    }
                } finally {
                    buf.release()
                }
            }
            return null
        } finally {
            crop.release(); resized.release()
        }
    }
}
