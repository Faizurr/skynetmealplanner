package com.attendance.kiosk.face

import android.content.Context
import com.attendance.kiosk.core.crypto.Hashing
import java.io.File
import java.io.IOException

/** The two ONNX models bundled in assets/models and their expected SHA-256. */
object FaceModels {
    const val YUNET = "face_detection_yunet_2023mar.onnx"
    const val SFACE = "face_recognition_sface_2021dec.onnx"
    val SHA256 = mapOf(
        YUNET to "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        SFACE to "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    )
}

/**
 * OpenCV loads models from file paths, so the APK assets are copied to filesDir once.
 * Every copy is verified against the pinned SHA-256 before use.
 */
object ModelInstaller {
    @Throws(IOException::class)
    fun install(context: Context): Map<String, File> {
        val dir = File(context.filesDir, "models").apply { mkdirs() }
        return FaceModels.SHA256.mapValues { (name, expected) ->
            val dest = File(dir, name)
            if (!dest.isFile || Hashing.sha256Hex(dest) != expected) {
                val tmp = File(dir, "$name.tmp")
                context.assets.open("models/$name").use { input -> tmp.outputStream().use { input.copyTo(it, 256 * 1024) } }
                val actual = Hashing.sha256Hex(tmp)
                if (actual != expected) {
                    tmp.delete()
                    throw IOException("Model $name failed its integrity check")
                }
                if (dest.exists()) dest.delete()
                if (!tmp.renameTo(dest)) throw IOException("Could not install model $name")
            }
            dest
        }
    }
}
