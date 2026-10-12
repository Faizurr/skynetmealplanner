package com.attendance.kiosk

import android.app.ActivityManager
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.attendance.kiosk.ui.KioskRoot
import com.attendance.kiosk.ui.KioskViewModel
import com.attendance.kiosk.ui.manager.ManagerViewModel
import com.attendance.kiosk.ui.theme.KioskTheme

/** Single-activity kiosk: keeps the screen on, hides system bars, supports screen pinning. */
class MainActivity : ComponentActivity() {
    private val kioskViewModel: KioskViewModel by viewModels()
    private val managerViewModel: ManagerViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()
        val graph = (application as KioskApplication).graph
        setContent {
            KioskTheme {
                KioskRoot(
                    vm = kioskViewModel,
                    managerVm = managerViewModel,
                    graph = graph,
                    isLocked = { isKioskLocked() },
                    startLock = { startKioskLock() },
                    stopLock = { stopKioskLock() },
                )
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun isKioskLocked(): Boolean {
        val am = getSystemService(ActivityManager::class.java) ?: return false
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    private fun startKioskLock() {
        try {
            startLockTask()
        } catch (e: RuntimeException) {
            Log.w("MainActivity", "startLockTask failed", e)
        }
    }

    private fun stopKioskLock() {
        try {
            stopLockTask()
        } catch (e: RuntimeException) {
            Log.w("MainActivity", "stopLockTask failed", e)
        }
    }
}
