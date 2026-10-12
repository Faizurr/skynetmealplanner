package com.attendance.kiosk.core.update

import com.attendance.kiosk.core.crypto.Hashing.toHex
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

sealed interface DownloadResult {
    data class Ok(val file: File, val sha256: String) : DownloadResult
    data class Failed(val message: String) : DownloadResult
}

/** Streams an APK to [dest] while hashing it. Only HTTPS URLs are fetched (unless [allowInsecure]). */
class ApkDownloader(private val client: OkHttpClient, private val allowInsecure: Boolean = false) {
    fun download(url: String, dest: File, maxBytes: Long = 300L * 1024 * 1024, onProgress: (Long, Long) -> Unit = { _, _ -> }): DownloadResult {
        if (!allowInsecure && !UpdatePolicy.isHttps(url)) return DownloadResult.Failed("The download link is not secure (HTTPS required).")
        val tmp = File(dest.parentFile, dest.name + ".part")
        try {
            dest.parentFile?.mkdirs()
            client.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) return DownloadResult.Failed("Download failed (HTTP ${resp.code}).")
                val body = resp.body ?: return DownloadResult.Failed("Download failed (empty response).")
                val total = body.contentLength()
                val md = MessageDigest.getInstance("SHA-256")
                var read = 0L
                body.byteStream().use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            read += n
                            if (read > maxBytes) return DownloadResult.Failed("The download is unexpectedly large.")
                            md.update(buf, 0, n)
                            out.write(buf, 0, n)
                            onProgress(read, total)
                        }
                    }
                }
                if (dest.exists()) dest.delete()
                if (!tmp.renameTo(dest)) return DownloadResult.Failed("Could not save the download.")
                return DownloadResult.Ok(dest, md.digest().toHex())
            }
        } catch (e: IOException) {
            return DownloadResult.Failed("Download failed: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
