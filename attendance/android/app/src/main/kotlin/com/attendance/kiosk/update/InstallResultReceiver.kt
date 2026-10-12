package com.attendance.kiosk.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import com.attendance.kiosk.KioskApplication

/** Receives PackageInstaller session results; launches the system confirmation when needed. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val updates = (context.applicationContext as? KioskApplication)?.graph?.updates
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        context.startActivity(confirm)
                    } catch (e: RuntimeException) {
                        updates?.onInstallResult(false, "The installer could not be opened (is kiosk lock on?)")
                    }
                } else {
                    updates?.onInstallResult(false, "The installer did not respond")
                }
            }
            PackageInstaller.STATUS_SUCCESS -> updates?.onInstallResult(true, null)
            else -> updates?.onInstallResult(false, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }
}
