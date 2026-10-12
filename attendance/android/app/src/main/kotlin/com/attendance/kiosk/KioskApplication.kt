package com.attendance.kiosk

import android.app.Application
import kotlinx.coroutines.launch

class KioskApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.connectivity.start()
        // Load OpenCV + models in the background so the first CHECK IN/OUT tap is fast.
        graph.analysisExecutor.execute { graph.faceEngine.warmUp() }
        graph.repository.startLoops(onDailyUpdateCheck = { graph.updates.check() })
        graph.appScope.launch { graph.repository.refreshCounts() }
    }
}
