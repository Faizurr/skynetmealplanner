package com.attendance.kiosk.core.format

import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

/** Formatting that matches the server's display strings (server/src/time.ts). */
object DisplayFormat {
    private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val DATE = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH)
    private val LONG_DATE = DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy", Locale.ENGLISH)
    private val CLOCK = DateTimeFormatter.ofPattern("h:mm", Locale.ENGLISH)
    private val AMPM = DateTimeFormatter.ofPattern("a", Locale.ENGLISH)
    private val DATE_TIME = DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a", Locale.ENGLISH)

    fun zone(tz: String?): ZoneId = try {
        if (tz.isNullOrBlank()) ZoneId.systemDefault() else ZoneId.of(tz)
    } catch (e: DateTimeException) {
        ZoneId.systemDefault()
    }

    /** "9:02 am" — same style as the server's `formatTime`. */
    fun time(at: Instant, zone: ZoneId): String = TIME.format(at.atZone(zone)).lowercase(Locale.ENGLISH)

    /** "12 October 2026" — same style as the server's `formatDate`. */
    fun date(at: Instant, zone: ZoneId): String = DATE.format(at.atZone(zone))

    /** "Monday, 12 October 2026" for the home screen. */
    fun longDate(at: Instant, zone: ZoneId): String = LONG_DATE.format(at.atZone(zone))

    /** Big clock digits "9:02" and the separate "am"/"pm" suffix. */
    fun clock(at: Instant, zone: ZoneId): Pair<String, String> =
        CLOCK.format(at.atZone(zone)) to AMPM.format(at.atZone(zone)).lowercase(Locale.ENGLISH)

    fun dateTime(at: Instant, zone: ZoneId): String = DATE_TIME.format(at.atZone(zone)).replace("AM", "am").replace("PM", "pm")

    /** "9h 06m" — same as the server's `formatDuration`. */
    fun duration(minutes: Int): String = "${minutes / 60}h ${(minutes % 60).toString().padStart(2, '0')}m"

    fun parseInstant(iso: String?): Instant? = try {
        if (iso.isNullOrBlank()) null else Instant.parse(iso)
    } catch (e: DateTimeParseException) {
        try {
            java.time.OffsetDateTime.parse(iso).toInstant()
        } catch (e2: DateTimeParseException) {
            null
        }
    }

    /** ISO-8601 UTC with millisecond precision, accepted by the server's `datetime({offset:true})`. */
    fun isoTimestamp(epochMs: Long): String = Instant.ofEpochMilli(epochMs).toString()

    /** Mirrors the server's greeting rule (morning < 12:00 ≤ afternoon < 17:00 ≤ evening). */
    fun greeting(at: Instant, zone: ZoneId, checkOut: Boolean, name: String): String {
        if (checkOut) return "See you next time, $name!"
        val h = at.atZone(zone).hour
        val part = if (h < 12) "Good morning" else if (h < 17) "Good afternoon" else "Good evening"
        return "$part, $name!"
    }

    /** Footer text for the sync indicator. */
    fun syncStatus(online: Boolean, pending: Int, failed: Int): String {
        val base = if (online) "Online" else "Offline"
        val parts = mutableListOf<String>()
        if (pending > 0) parts += "$pending waiting to sync"
        if (failed > 0) parts += "$failed need attention"
        if (parts.isEmpty()) return if (online) "$base · All synced" else "$base · Records will be saved on this device"
        return "$base · ${parts.joinToString(" · ")}"
    }
}
