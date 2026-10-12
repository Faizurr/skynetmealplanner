package com.attendance.kiosk.core.format

import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.face.Guidance
import com.attendance.kiosk.core.liveness.LivenessPrompt
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DisplayFormatTest {
    private val kl = ZoneId.of("Asia/Kuala_Lumpur")
    private val at = Instant.parse("2026-10-12T01:02:00Z") // 9:02 am, Monday in KL

    @Test
    fun `time and date match the server style`() {
        assertEquals("9:02 am", DisplayFormat.time(at, kl))
        assertEquals("12 October 2026", DisplayFormat.date(at, kl))
        assertEquals("Monday, 12 October 2026", DisplayFormat.longDate(at, kl))
        assertEquals("9:02" to "am", DisplayFormat.clock(at, kl))
        assertEquals("5:30 pm", DisplayFormat.time(Instant.parse("2026-10-12T09:30:00Z"), kl))
        assertEquals("12:05 am", DisplayFormat.time(Instant.parse("2026-10-11T16:05:00Z"), kl))
    }

    @Test
    fun `duration matches formatDuration`() {
        assertEquals("9h 06m", DisplayFormat.duration(546))
        assertEquals("0h 00m", DisplayFormat.duration(0))
    }

    @Test
    fun `greeting follows the server rule`() {
        assertEquals("Good morning, Sarah!", DisplayFormat.greeting(at, kl, false, "Sarah"))
        assertEquals("Good afternoon, Sarah!", DisplayFormat.greeting(Instant.parse("2026-10-12T05:00:00Z"), kl, false, "Sarah"))
        assertEquals("Good evening, Sarah!", DisplayFormat.greeting(Instant.parse("2026-10-12T10:00:00Z"), kl, false, "Sarah"))
        assertEquals("See you next time, Sarah!", DisplayFormat.greeting(at, kl, true, "Sarah"))
    }

    @Test
    fun `zone falls back on invalid ids`() {
        assertEquals(ZoneId.systemDefault(), DisplayFormat.zone("Not/AZone"))
        assertEquals(kl, DisplayFormat.zone("Asia/Kuala_Lumpur"))
    }

    @Test
    fun `parses server timestamps and builds iso device timestamps`() {
        assertEquals(at, DisplayFormat.parseInstant("2026-10-12T01:02:00.000Z"))
        assertEquals(at, DisplayFormat.parseInstant("2026-10-12T09:02:00+08:00"))
        assertNull(DisplayFormat.parseInstant("yesterday"))
        assertEquals("2026-10-12T01:02:00.123Z", DisplayFormat.isoTimestamp(at.toEpochMilli() + 123))
    }

    @Test
    fun `sync status text`() {
        assertEquals("Online · All synced", DisplayFormat.syncStatus(true, 0, 0))
        assertEquals("Offline · 2 waiting to sync", DisplayFormat.syncStatus(false, 2, 0))
        assertEquals("Online · 1 waiting to sync · 1 need attention", DisplayFormat.syncStatus(true, 1, 1))
    }

    @Test
    fun `camera copy`() {
        assertEquals("Position your face inside the frame.", KioskText.guidance(Guidance.POSITION_FACE))
        assertEquals("Only one person at a time, please.", KioskText.guidance(Guidance.ONE_PERSON_ONLY))
        assertEquals("Come a little closer.", KioskText.guidance(Guidance.COME_CLOSER))
        assertEquals("Slowly turn your head to the LEFT", KioskText.liveness(LivenessPrompt.TURN_LEFT))
        assertEquals("Now look straight ahead", KioskText.liveness(LivenessPrompt.LOOK_STRAIGHT))
        assertEquals("Checking IN", KioskText.actionInProgress(Action.CHECK_IN))
    }
}
