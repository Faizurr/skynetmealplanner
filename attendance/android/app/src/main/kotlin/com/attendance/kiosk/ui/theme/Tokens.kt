package com.attendance.kiosk.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Raw palette. Calm, warm neutrals with two confident action colours. */
object Palette {
    // Warm neutrals
    val Linen = Color(0xFFFBF8F3)
    val Paper = Color(0xFFFFFFFF)
    val Sand = Color(0xFFF1ECE3)
    val Stone = Color(0xFFE4DDD1)
    val Ink = Color(0xFF1D1B18)
    val InkMuted = Color(0xFF6B655C)
    val Charcoal = Color(0xFF12110F)
    val CharcoalRaised = Color(0xFF1C1B19)
    val CharcoalHigh = Color(0xFF282623)
    val Cream = Color(0xFFF3EFE8)
    val CreamMuted = Color(0xFFA8A196)

    // CHECK IN — deep teal-green
    val Teal700 = Color(0xFF0F6E62)
    val Teal600 = Color(0xFF13806F)
    val Teal300 = Color(0xFF5CC9B3)
    val Teal100 = Color(0xFFD5F0EA)
    val Teal900 = Color(0xFF0A3C35)

    // CHECK OUT — indigo
    val Indigo700 = Color(0xFF3A3796)
    val Indigo600 = Color(0xFF4744B0)
    val Indigo300 = Color(0xFFA9A6F5)
    val Indigo100 = Color(0xFFE3E2FB)
    val Indigo900 = Color(0xFF221F5C)

    // Accents & status
    val Saffron = Color(0xFFC9822B)
    val SaffronLight = Color(0xFFF3C98B)
    val Amber100 = Color(0xFFFBEBD2)
    val Amber900 = Color(0xFF5A3A0C)
    val Red600 = Color(0xFFB3261E)
    val Red200 = Color(0xFFF2B8B5)
    val Green600 = Color(0xFF2E7D4F)
    val Green300 = Color(0xFF7FD3A0)
}

/** Semantic colours not covered by Material's scheme. */
@Immutable
data class KioskColors(
    val checkIn: Color,
    val onCheckIn: Color,
    val checkInSoft: Color,
    val checkOut: Color,
    val onCheckOut: Color,
    val checkOutSoft: Color,
    val warning: Color,
    val warningSoft: Color,
    val onWarningSoft: Color,
    val online: Color,
    val offline: Color,
    val muted: Color,
    val hairline: Color,
    val cameraScrim: Color,
)

val LightKioskColors = KioskColors(
    checkIn = Palette.Teal700, onCheckIn = Color.White, checkInSoft = Palette.Teal100,
    checkOut = Palette.Indigo700, onCheckOut = Color.White, checkOutSoft = Palette.Indigo100,
    warning = Palette.Saffron, warningSoft = Palette.Amber100, onWarningSoft = Palette.Amber900,
    online = Palette.Green600, offline = Palette.Red600,
    muted = Palette.InkMuted, hairline = Palette.Stone, cameraScrim = Color(0xB3000000),
)

val DarkKioskColors = KioskColors(
    checkIn = Palette.Teal300, onCheckIn = Palette.Teal900, checkInSoft = Color(0xFF16332E),
    checkOut = Palette.Indigo300, onCheckOut = Palette.Indigo900, checkOutSoft = Color(0xFF26244A),
    warning = Palette.SaffronLight, warningSoft = Color(0xFF3A2A12), onWarningSoft = Palette.SaffronLight,
    online = Palette.Green300, offline = Palette.Red200,
    muted = Palette.CreamMuted, hairline = Color(0xFF34312C), cameraScrim = Color(0xB3000000),
)

val LocalKioskColors = staticCompositionLocalOf { LightKioskColors }

/** 4-pt spacing scale. */
object Spacing {
    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 24.dp
    val xl = 32.dp
    val xxl = 48.dp
}

object Shapes {
    val pill = RoundedCornerShape(percent = 50)
    val card = RoundedCornerShape(24.dp)
    val action = RoundedCornerShape(32.dp)
    val small = RoundedCornerShape(12.dp)
}

/** Minimum touch target for employee-facing controls (well above the 48 dp guideline). */
val KioskTouchTarget = 64.dp
