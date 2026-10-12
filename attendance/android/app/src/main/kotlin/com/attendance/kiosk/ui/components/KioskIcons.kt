package com.attendance.kiosk.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** Stroke icons drawn for the kiosk (tinted by Icon like any vector). */
object KioskIcons {
    private fun stroke(name: String, block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .path(
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathBuilder = block,
            )
            .build()

    /** Arrow entering a door frame (CHECK IN). */
    val CheckIn: ImageVector by lazy {
        stroke("CheckIn") {
            moveTo(14f, 3.5f); lineTo(18.5f, 3.5f); lineTo(18.5f, 20.5f); lineTo(14f, 20.5f)
            moveTo(3.5f, 12f); lineTo(13.5f, 12f)
            moveTo(9.5f, 7.5f); lineTo(14f, 12f); lineTo(9.5f, 16.5f)
        }
    }

    /** Arrow leaving a door frame (CHECK OUT). */
    val CheckOut: ImageVector by lazy {
        stroke("CheckOut") {
            moveTo(10f, 3.5f); lineTo(5.5f, 3.5f); lineTo(5.5f, 20.5f); lineTo(10f, 20.5f)
            moveTo(10.5f, 12f); lineTo(20.5f, 12f)
            moveTo(16f, 7.5f); lineTo(20.5f, 12f); lineTo(16f, 16.5f)
        }
    }

    val Backspace: ImageVector by lazy {
        stroke("Backspace") {
            moveTo(8f, 5f); lineTo(20f, 5f); lineTo(20f, 19f); lineTo(8f, 19f); lineTo(2.5f, 12f); close()
            moveTo(11f, 9f); lineTo(17f, 15f)
            moveTo(17f, 9f); lineTo(11f, 15f)
        }
    }

    /** Numeric keypad glyph for "Use staff PIN". */
    val Keypad: ImageVector by lazy {
        stroke("Keypad") {
            for (row in 0..2) for (col in 0..2) {
                val cx = 6f + col * 6f
                val cy = 5f + row * 6f
                moveTo(cx - 0.6f, cy); lineTo(cx + 0.6f, cy)
            }
            moveTo(11.4f, 21f); lineTo(12.6f, 21f)
        }
    }

    val CloudOff: ImageVector by lazy {
        stroke("CloudOff") {
            moveTo(7f, 18f); lineTo(17.5f, 18f)
            moveTo(20.5f, 15f); curveTo(20.5f, 12.5f, 18.8f, 11f, 16.8f, 11f)
            curveTo(16.2f, 7.8f, 13.7f, 6f, 11f, 6f)
            moveTo(7.5f, 8f); curveTo(5f, 9f, 3.5f, 11f, 3.5f, 13.5f); curveTo(3.5f, 16f, 5f, 18f, 7f, 18f)
            moveTo(3f, 3f); lineTo(21f, 21f)
        }
    }
}
