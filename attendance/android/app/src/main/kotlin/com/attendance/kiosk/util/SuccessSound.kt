package com.attendance.kiosk.util

import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper

/** A short, gentle confirmation tone (no bundled audio needed). */
class SuccessSound {
    private val handler = Handler(Looper.getMainLooper())

    fun play() {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60)
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 180)
            handler.postDelayed({ runCatching { tone.release() } }, 400)
        } catch (e: RuntimeException) {
            // Some devices refuse ToneGenerator (audio focus / HAL issues); sound is optional.
        }
    }
}
