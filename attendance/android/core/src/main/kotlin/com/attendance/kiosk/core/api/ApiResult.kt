package com.attendance.kiosk.core.api

import java.io.IOException

/** Outcome of one HTTP call. Network problems are values, never thrown. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>

    /** The server answered with a non-2xx status. */
    data class Http(val status: Int, val body: ErrorBody?) : ApiResult<Nothing> {
        val code: String get() = body?.error ?: "http_$status"
        val message: String? get() = body?.message
        val isServerError: Boolean get() = status >= 500
        val isDeviceRevoked: Boolean
            get() = status == 401 && (code == "device_revoked" || code == "device_unauthenticated")
        val isManagerExpired: Boolean get() = status == 401 && code == "manager_unauthenticated"
    }

    /** No usable answer: DNS failure, refused connection, TLS error, timeout, malformed body. */
    data class Network(val error: IOException) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(f: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Ok -> ApiResult.Ok(f(value))
    is ApiResult.Http -> this
    is ApiResult.Network -> this
}

fun <T> ApiResult<T>.valueOrNull(): T? = (this as? ApiResult.Ok)?.value

/** Human-readable one-liner for logs, heartbeat `last_error` and manager screens. */
fun ApiResult<*>.describe(): String = when (this) {
    is ApiResult.Ok -> "ok"
    is ApiResult.Http -> "HTTP $status ${code}${message?.let { ": $it" } ?: ""}"
    is ApiResult.Network -> "Network: ${error.message ?: error.javaClass.simpleName}"
}
