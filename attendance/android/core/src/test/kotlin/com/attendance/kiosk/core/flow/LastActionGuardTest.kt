package com.attendance.kiosk.core.flow

import com.attendance.kiosk.core.api.Action
import kotlin.test.Test
import kotlin.test.assertEquals

class LastActionGuardTest {
    private val now = 1_000_000_000_000L
    private val hour = 3_600_000L

    @Test
    fun `no knowledge allows anything`() {
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_IN, null, now, 1))
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_OUT, null, now, 1))
    }

    @Test
    fun `check in twice is blocked`() {
        assertEquals(GuardResult.AlreadyCheckedIn(now - hour), LastActionGuard.check(Action.CHECK_IN, LastAction(Action.CHECK_IN, now - hour), now, 1))
    }

    @Test
    fun `check out without check in is blocked`() {
        assertEquals(GuardResult.NotCheckedIn, LastActionGuard.check(Action.CHECK_OUT, LastAction(Action.CHECK_OUT, now - hour), now, 1))
    }

    @Test
    fun `check out right after check in is too soon`() {
        assertEquals(GuardResult.TooSoon(now - 30_000), LastActionGuard.check(Action.CHECK_OUT, LastAction(Action.CHECK_IN, now - 30_000), now, 1))
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_OUT, LastAction(Action.CHECK_IN, now - 61_000), now, 1))
    }

    @Test
    fun `normal alternation is allowed`() {
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_IN, LastAction(Action.CHECK_OUT, now - hour), now, 1))
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_OUT, LastAction(Action.CHECK_IN, now - 8 * hour), now, 1))
    }

    @Test
    fun `stale or future knowledge is ignored`() {
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_IN, LastAction(Action.CHECK_IN, now - 17 * hour), now, 1))
        assertEquals(GuardResult.Allowed, LastActionGuard.check(Action.CHECK_IN, LastAction(Action.CHECK_IN, now + 2 * hour), now, 1))
    }
}
