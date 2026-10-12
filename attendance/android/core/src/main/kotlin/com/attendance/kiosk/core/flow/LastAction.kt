package com.attendance.kiosk.core.flow

import com.attendance.kiosk.core.api.Action
import kotlinx.serialization.Serializable

/** Last action this kiosk knows about for an employee (from server results or offline saves). */
@Serializable
data class LastAction(val action: Action, val atMs: Long)

interface LastActionStore {
    fun get(employeeId: String): LastAction?
    fun put(employeeId: String, value: LastAction)
}

class InMemoryLastActionStore : LastActionStore {
    private val map = HashMap<String, LastAction>()
    @Synchronized override fun get(employeeId: String): LastAction? = map[employeeId]
    @Synchronized override fun put(employeeId: String, value: LastAction) { map[employeeId] = value }
    @Synchronized fun snapshot(): Map<String, LastAction> = HashMap(map)
}

sealed interface GuardResult {
    data object Allowed : GuardResult
    data class AlreadyCheckedIn(val sinceMs: Long) : GuardResult
    data object NotCheckedIn : GuardResult
    data class TooSoon(val checkInMs: Long) : GuardResult
}

/**
 * Local sanity check used only for OFFLINE saves, where the server cannot be asked. It blocks
 * obviously wrong actions based on what this kiosk saw; it never changes the requested action.
 * Knowledge older than [staleAfterMs] is ignored (another kiosk may have been used since).
 */
object LastActionGuard {
    const val DEFAULT_STALE_AFTER_MS = 16L * 3_600_000L

    fun check(
        requested: Action,
        last: LastAction?,
        nowMs: Long,
        minMinutesBetweenInAndOut: Int,
        staleAfterMs: Long = DEFAULT_STALE_AFTER_MS,
    ): GuardResult {
        if (last == null || nowMs - last.atMs > staleAfterMs || last.atMs > nowMs + 60_000) return GuardResult.Allowed
        return when (requested) {
            Action.CHECK_IN ->
                if (last.action == Action.CHECK_IN) GuardResult.AlreadyCheckedIn(last.atMs) else GuardResult.Allowed
            Action.CHECK_OUT -> when {
                last.action == Action.CHECK_OUT -> GuardResult.NotCheckedIn
                nowMs - last.atMs < minMinutesBetweenInAndOut * 60_000L -> GuardResult.TooSoon(last.atMs)
                else -> GuardResult.Allowed
            }
        }
    }
}
