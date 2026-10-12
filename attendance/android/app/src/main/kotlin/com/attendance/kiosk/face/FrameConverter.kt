package com.attendance.kiosk.face

import androidx.camera.core.ImageProxy
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Converts a CameraX RGBA_8888 [ImageProxy] into an upright BGR [Mat] whose long side is at
 * most [maxSide] px (handles row-stride padding and the sensor rotation). Reuses its buffers;
 * use one instance per analysis thread.
 */
class FrameConverter(private val maxSide: Int = 640) {
    private var rowBuffer = ByteArray(0)
    private var frameBuffer = ByteArray(0)

    fun toBgr(image: ImageProxy): Mat {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val rowStride = plane.rowStride
        val w = image.width
        val h = image.height
        val rowBytes = w * 4
        val rgba = Mat(h, w, CvType.CV_8UC4)
        val bgr = Mat()
        val rotated = Mat()
        try {
            buffer.rewind()
            if (rowStride == rowBytes) {
                val size = rowBytes * h
                if (frameBuffer.size != size) frameBuffer = ByteArray(size)
                buffer.get(frameBuffer, 0, size)
                rgba.put(0, 0, frameBuffer)
            } else {
                if (rowBuffer.size != rowBytes) rowBuffer = ByteArray(rowBytes)
                for (y in 0 until h) {
                    buffer.position(y * rowStride)
                    buffer.get(rowBuffer, 0, rowBytes)
                    rgba.put(y, 0, rowBuffer)
                }
            }
            // The models expect BGR, like cv2.imread in the reference pipeline.
            Imgproc.cvtColor(rgba, bgr, Imgproc.COLOR_RGBA2BGR)
            val upright = when (image.imageInfo.rotationDegrees) {
                90 -> { Core.rotate(bgr, rotated, Core.ROTATE_90_CLOCKWISE); rotated }
                180 -> { Core.rotate(bgr, rotated, Core.ROTATE_180); rotated }
                270 -> { Core.rotate(bgr, rotated, Core.ROTATE_90_COUNTERCLOCKWISE); rotated }
                else -> bgr
            }
            val longSide = max(upright.cols(), upright.rows())
            if (longSide <= maxSide) {
                return upright.clone()
            }
            val scale = maxSide.toDouble() / longSide
            val out = Mat()
            Imgproc.resize(
                upright, out,
                Size((upright.cols() * scale).roundToInt().toDouble(), (upright.rows() * scale).roundToInt().toDouble()),
                0.0, 0.0, Imgproc.INTER_AREA,
            )
            return out
        } finally {
            rgba.release(); bgr.release(); rotated.release()
        }
    }
}
