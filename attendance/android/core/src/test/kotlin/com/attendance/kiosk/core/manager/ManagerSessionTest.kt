package com.attendance.kiosk.core.manager

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ManagerSessionTest {
    @Test
    fun `expires after inactivity`() {
        val s = ManagerSession("t", "Owner", "owner", 0, 900)
        assertFalse(s.isExpired(60_000))
        assertTrue(s.isExpired(3 * 60_000))
    }

    @Test
    fun `activity extends up to the 15 minute limit`() {
        val s = ManagerSession("t", "Owner", "owner", 0, 900)
        var t = 0L
        while (t < 14 * 60_000) { t += 60_000; s.touch(t); assertFalse(s.isExpired(t)) }
        assertTrue(s.isExpired(15 * 60_000))
    }

    @Test
    fun `server lifetime shorter than 15 minutes wins`() {
        val s = ManagerSession("t", "Owner", "owner", 0, 60)
        s.touch(50_000)
        assertTrue(s.isExpired(60_000))
        assertEquals(0, s.remainingMs(70_000))
    }
}
