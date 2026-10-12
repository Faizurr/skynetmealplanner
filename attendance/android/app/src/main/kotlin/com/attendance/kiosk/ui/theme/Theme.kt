package com.attendance.kiosk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val LightScheme = lightColorScheme(
    primary = Palette.Teal700,
    onPrimary = Palette.Paper,
    primaryContainer = Palette.Teal100,
    onPrimaryContainer = Palette.Teal900,
    secondary = Palette.Indigo700,
    onSecondary = Palette.Paper,
    secondaryContainer = Palette.Indigo100,
    onSecondaryContainer = Palette.Indigo900,
    tertiary = Palette.Saffron,
    background = Palette.Linen,
    onBackground = Palette.Ink,
    surface = Palette.Paper,
    onSurface = Palette.Ink,
    surfaceVariant = Palette.Sand,
    onSurfaceVariant = Palette.InkMuted,
    outline = Palette.Stone,
    error = Palette.Red600,
)

private val DarkScheme = darkColorScheme(
    primary = Palette.Teal300,
    onPrimary = Palette.Teal900,
    primaryContainer = Palette.Teal900,
    onPrimaryContainer = Palette.Teal100,
    secondary = Palette.Indigo300,
    onSecondary = Palette.Indigo900,
    secondaryContainer = Palette.Indigo900,
    onSecondaryContainer = Palette.Indigo100,
    tertiary = Palette.SaffronLight,
    background = Palette.Charcoal,
    onBackground = Palette.Cream,
    surface = Palette.CharcoalRaised,
    onSurface = Palette.Cream,
    surfaceVariant = Palette.CharcoalHigh,
    onSurfaceVariant = Palette.CreamMuted,
    outline = Color(0xFF3B3833),
    error = Palette.Red200,
)

/** Large, high-contrast type scale for a wall-mounted or counter-top kiosk. */
private val KioskTypography = Typography(
    displayLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Light, fontSize = 88.sp, lineHeight = 92.sp, letterSpacing = (-2).sp),
    displayMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Light, fontSize = 64.sp, lineHeight = 70.sp, letterSpacing = (-1.5).sp),
    displaySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 44.sp, lineHeight = 52.sp, letterSpacing = (-0.5).sp),
    headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 36.sp, lineHeight = 44.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 38.sp),
    headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 18.sp, lineHeight = 24.sp, letterSpacing = 0.1.sp),
    titleSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 18.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 22.sp, letterSpacing = 0.5.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 18.sp, letterSpacing = 0.4.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.5.sp),
)

/** Text style of the CHECK IN / CHECK OUT labels. */
val ActionLabelStyle = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 34.sp, lineHeight = 40.sp, letterSpacing = 2.sp)
val ActionLabelCompactStyle = ActionLabelStyle.copy(fontSize = 26.sp, lineHeight = 30.sp, letterSpacing = 1.5.sp)

@Composable
fun KioskTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalKioskColors provides if (dark) DarkKioskColors else LightKioskColors) {
        MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, typography = KioskTypography, content = content)
    }
}

object KioskTheme {
    val colors: KioskColors
        @Composable get() = LocalKioskColors.current
}
