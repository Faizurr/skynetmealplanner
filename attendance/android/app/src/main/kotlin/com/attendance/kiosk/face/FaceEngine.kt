package com.attendance.kiosk.face

import android.content.Context
import android.util.Log
import com.attendance.kiosk.core.face.EmbeddingCodec
import com.attendance.kiosk.core.face.FaceObservation
import org.opencv.android.OpenCVLoader
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import org.opencv.objdetect.FaceDetectorYN
import org.opencv.objdetect.FaceRecognizerSF

/** YuNet detections of one frame. [rows] are the raw 15-float rows used for alignment. */
class Detections(val faces: List<FaceObservation>, val rows: List<FloatArray>)

class Embedding(val vector: FloatArray, val sharpness: Double)

sealed interface EngineStatus {
    data object NotLoaded : EngineStatus
    data object Loading : EngineStatus
    data object Ready : EngineStatus
    data class Failed(val message: String) : EngineStatus
}

/**
 * The recognition pipeline, identical to tools/face-eval/eval.py:
 * YuNet (score 0.8, NMS 0.3, topK 5000) → SFace alignCrop → feature → L2-normalise.
 * Input frames are BGR Mats (long side ≤ 640 px). Thread-confined by a lock; the camera
 * analysers call it from a single background executor.
 */
class FaceEngine(private val context: Context) {
    companion object {
        private const val TAG = "FaceEngine"
        const val SCORE_THRESHOLD = 0.8f
        const val NMS_THRESHOLD = 0.3f
        const val TOP_K = 5000
    }

    private val lock = Any()
    private var detector: FaceDetectorYN? = null
    private var recognizer: FaceRecognizerSF? = null

    @Volatile var status: EngineStatus = EngineStatus.NotLoaded
        private set

    /** Loads OpenCV and both models once. Safe to call repeatedly from any background thread. */
    fun ensureLoaded(): Boolean = synchronized(lock) {
        if (status == EngineStatus.Ready) return true
        status = EngineStatus.Loading
        try {
            if (!OpenCVLoader.initLocal()) {
                status = EngineStatus.Failed("OpenCV native library could not be loaded")
                return false
            }
            val files = ModelInstaller.install(context)
            detector = FaceDetectorYN.create(
                files.getValue(FaceModels.YUNET).absolutePath, "", Size(320.0, 320.0),
                SCORE_THRESHOLD, NMS_THRESHOLD, TOP_K,
            )
            recognizer = FaceRecognizerSF.create(files.getValue(FaceModels.SFACE).absolutePath, "")
            status = EngineStatus.Ready
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Face engine failed to load", t)
            status = EngineStatus.Failed(t.message ?: t.javaClass.simpleName)
            false
        }
    }

    /** Warm-up: loads everything and runs one inference so the first real tap is fast. */
    fun warmUp() {
        if (!ensureLoaded()) return
        val blank = Mat(480, 640, CvType.CV_8UC3, org.opencv.core.Scalar(127.0, 127.0, 127.0))
        try {
            detect(blank)
            val row = floatArrayOf(240f, 160f, 160f, 160f, 290f, 220f, 350f, 220f, 320f, 260f, 295f, 290f, 345f, 290f, 0.9f)
            embed(blank, row)
        } catch (t: Throwable) {
            Log.w(TAG, "warm-up inference failed", t)
        } finally {
            blank.release()
        }
    }

    fun detect(bgr: Mat): Detections = synchronized(lock) {
        val det = detector ?: return Detections(emptyList(), emptyList())
        det.setInputSize(Size(bgr.cols().toDouble(), bgr.rows().toDouble()))
        val out = Mat()
        try {
            det.detect(bgr, out)
            if (out.empty() || out.cols() < FaceObservation.ROW_LENGTH) return Detections(emptyList(), emptyList())
            val rows = ArrayList<FloatArray>(out.rows())
            for (i in 0 until out.rows()) {
                val r = FloatArray(out.cols())
                out.get(i, 0, r)
                rows += r
            }
            Detections(rows.map { FaceObservation.fromYuNetRow(it) }, rows)
        } finally {
            out.release()
        }
    }

    /** SFace embedding (L2-normalised) of the face described by a YuNet [row], plus crop sharpness. */
    fun embed(bgr: Mat, row: FloatArray): Embedding = synchronized(lock) {
        val rec = recognizer ?: throw IllegalStateException("Face engine not loaded")
        val box = Mat(1, FaceObservation.ROW_LENGTH, CvType.CV_32F)
        val aligned = Mat()
        val feature = Mat()
        val gray = Mat()
        val lap = Mat()
        val mean = MatOfDouble()
        val std = MatOfDouble()
        try {
            box.put(0, 0, row.copyOf(FaceObservation.ROW_LENGTH))
            rec.alignCrop(bgr, box, aligned)
            rec.feature(aligned, feature)
            val flat = feature.reshape(1, 1)
            val raw = FloatArray(EmbeddingCodec.DIM)
            check(flat.total() >= EmbeddingCodec.DIM) { "unexpected feature size ${flat.total()}" }
            flat.get(0, 0, raw)
            // Sharpness: variance of the Laplacian of the aligned grey crop.
            Imgproc.cvtColor(aligned, gray, Imgproc.COLOR_BGR2GRAY)
            Imgproc.Laplacian(gray, lap, CvType.CV_64F)
            Core.meanStdDev(lap, mean, std)
            val sd = std.toArray().firstOrNull() ?: 0.0
            Embedding(EmbeddingCodec.normalize(raw), sd * sd)
        } finally {
            box.release(); aligned.release(); feature.release(); gray.release(); lap.release(); mean.release(); std.release()
        }
    }
}
