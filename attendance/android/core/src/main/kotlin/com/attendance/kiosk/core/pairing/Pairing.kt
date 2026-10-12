package com.attendance.kiosk.core.pairing

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object PairingCode {
    /**
     * Normalises user input to the dashboard format "K7Q-4MX-29P" (same rule as the server's
     * normalizePairingCode). Accepts lowercase, spaces and missing dashes. Null if not 9 characters.
     */
    fun normalize(input: String): String? {
        val raw = input.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
        if (raw.length != 9) return null
        return raw.chunked(3).joinToString("-")
    }
}

sealed interface ServerUrlResult {
    data class Valid(val url: HttpUrl) : ServerUrlResult
    data class Invalid(val message: String) : ServerUrlResult
}

object ServerUrlValidator {
    /**
     * HTTPS is required. Plain HTTP is accepted only in debug builds and only for local
     * development hosts (Android emulator 10.0.2.2, localhost, 127.0.0.1, 192.168.x.x).
     */
    fun validate(input: String, debugBuild: Boolean): ServerUrlResult {
        var text = input.trim()
        if (text.isEmpty()) return ServerUrlResult.Invalid("Enter the server address.")
        if (!text.contains("://")) text = "https://$text"
        val url = text.trimEnd('/').toHttpUrlOrNull()
            ?: return ServerUrlResult.Invalid("That doesn't look like a web address.")
        if (url.query != null || url.fragment != null) return ServerUrlResult.Invalid("Enter only the server address, without ? or #.")
        if (!url.isHttps) {
            if (!debugBuild) return ServerUrlResult.Invalid("The server address must start with https://")
            if (!isLocalDevHost(url.host)) return ServerUrlResult.Invalid("http:// is only allowed for local test servers. Use https://")
        }
        return ServerUrlResult.Valid(url)
    }

    fun isLocalDevHost(host: String): Boolean {
        if (host == "10.0.2.2" || host == "localhost" || host == "127.0.0.1") return true
        val parts = host.split('.')
        return parts.size == 4 && parts[0] == "192" && parts[1] == "168" &&
            parts.drop(2).all { p -> p.toIntOrNull()?.let { it in 0..255 } == true }
    }
}
