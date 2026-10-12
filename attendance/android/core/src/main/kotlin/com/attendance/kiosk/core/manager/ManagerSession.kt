package com.attendance.kiosk.core.manager

/**
 * Manager mode session. The token is kept in memory only. It ends after the server lifetime
 * (15 min) or after [inactivityMs] without interaction, whichever comes first.
 */
class ManagerSession(
    val token: String,
    val fullName: String,
    val role: String,
    private val startedAtMs: Long,
    expiresInSeconds: Int,
    private val inactivityMs: Long = DEFAULT_INACTIVITY_MS,
) {
    companion object {
        const val DEFAULT_INACTIVITY_MS = 3L * 60_000L
        const val MAX_LIFETIME_MS = 15L * 60_000L
    }

    private val expiresAtMs = startedAtMs + minOf(expiresInSeconds * 1000L, MAX_LIFETIME_MS)

    @Volatile var lastActivityMs: Long = startedAtMs
        private set

    fun touch(nowMs: Long) {
        if (nowMs > lastActivityMs) lastActivityMs = nowMs
    }

    fun isExpired(nowMs: Long): Boolean = nowMs >= expiresAtMs || nowMs - lastActivityMs >= inactivityMs

    fun remainingMs(nowMs: Long): Long = maxOf(0L, minOf(expiresAtMs, lastActivityMs + inactivityMs) - nowMs)
}
