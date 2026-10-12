package com.attendance.kiosk.update

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import com.attendance.kiosk.BuildConfig
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.ReleaseInfo
import com.attendance.kiosk.core.api.describe
import com.attendance.kiosk.core.crypto.Hashing
import com.attendance.kiosk.core.update.ApkDownloader
import com.attendance.kiosk.core.update.ApkFacts
import com.attendance.kiosk.core.update.ApkVerdict
import com.attendance.kiosk.core.update.DownloadResult
import com.attendance.kiosk.core.update.UpdateDecision
import com.attendance.kiosk.core.update.UpdatePolicy
import com.attendance.kiosk.data.KioskRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val release: ReleaseInfo, val mandatory: Boolean) : UpdateState
    data class Downloading(val release: ReleaseInfo, val progress: Float?) : UpdateState
    data class Verified(val release: ReleaseInfo, val file: File) : UpdateState
    data class Installing(val release: ReleaseInfo) : UpdateState
    data class Failed(val message: String, val release: ReleaseInfo? = null) : UpdateState
}

/**
 * Self-update. The downloaded APK is installed only if its SHA-256, package name, version and
 * signing certificate all check out (see UpdatePolicy). Installation always goes through the
 * system PackageInstaller, which asks the user to confirm on consumer devices.
 */
class UpdateManager(private val context: Context, private val repository: KioskRepository) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** Latest known available release (drives the banner), independent of download state. */
    private val _available = MutableStateFlow<UpdateState.Available?>(null)
    val available: StateFlow<UpdateState.Available?> = _available.asStateFlow()

    /** Blocking; call on an IO dispatcher. */
    fun check() {
        _state.value = UpdateState.Checking
        when (val r = repository.latestRelease()) {
            is ApiResult.Ok -> when (val d = UpdatePolicy.decide(BuildConfig.VERSION_CODE, r.value)) {
                UpdateDecision.UpToDate -> {
                    _available.value = null
                    _state.value = UpdateState.UpToDate
                }
                is UpdateDecision.Available -> {
                    val a = UpdateState.Available(d.release, d.mandatory)
                    _available.value = a
                    _state.value = a
                }
                is UpdateDecision.Invalid -> _state.value = UpdateState.Failed("The published update is not valid: ${d.reason}")
            }
            else -> _state.value = UpdateState.Failed("Could not check for updates (${r.describe()})")
        }
    }

    fun canInstallPackages(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun isInLockTaskMode(): Boolean {
        val am = context.getSystemService(ActivityManager::class.java) ?: return false
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    /** Downloads and verifies [release]. Blocking; call on an IO dispatcher. */
    fun downloadAndVerify(release: ReleaseInfo) {
        _state.value = UpdateState.Downloading(release, null)
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val dest = File(dir, "kiosk-${release.versionCode}.apk")
        val result = ApkDownloader(repository.downloadClient).download(release.apkUrl, dest) { read, total ->
            _state.value = UpdateState.Downloading(release, if (total > 0) read.toFloat() / total else null)
        }
        when (result) {
            is DownloadResult.Failed -> _state.value = UpdateState.Failed(result.message, release)
            is DownloadResult.Ok -> {
                val verdict = UpdatePolicy.verifyApk(
                    release = release,
                    fileSha256 = result.sha256,
                    apk = readApkFacts(result.file),
                    ownPackage = context.packageName,
                    ownVersionCode = BuildConfig.VERSION_CODE.toLong(),
                    ownCertSha256 = ownCertificates(),
                )
                when (verdict) {
                    ApkVerdict.Accept -> _state.value = UpdateState.Verified(release, result.file)
                    is ApkVerdict.Reject -> {
                        result.file.delete()
                        _state.value = UpdateState.Failed("Update rejected: ${verdict.message}", release)
                    }
                }
            }
        }
    }

    /** Hands a verified APK to the system installer. */
    fun install(release: ReleaseInfo, apk: File) {
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(context.packageName)
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("kiosk.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 256 * 1024) }
                    session.fsync(out)
                }
                val intent = Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
                session.commit(pending.intentSender)
            }
            _state.value = UpdateState.Installing(release)
        } catch (e: Exception) {
            _state.value = UpdateState.Failed("Could not start the installer: ${e.message ?: e.javaClass.simpleName}", release)
        }
    }

    fun onInstallResult(success: Boolean, message: String?) {
        _state.value = if (success) UpdateState.Idle else UpdateState.Failed("Installation did not complete${message?.let { ": $it" } ?: ""}")
    }

    fun reset() {
        _state.value = _available.value ?: UpdateState.Idle
    }

    // --- Signatures -------------------------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun readApkFacts(file: File): ApkFacts? {
        val pm = context.packageManager
        val archive: PackageInfo? = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageArchiveInfo(file.absolutePath, PackageManager.PackageInfoFlags.of(signatureFlag().toLong()))
            } else {
                pm.getPackageArchiveInfo(file.absolutePath, signatureFlag())
            }
        } catch (e: Exception) {
            null
        }
        val info = archive ?: return null
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        return ApkFacts(info.packageName, versionCode, certHashes(info))
    }

    @Suppress("DEPRECATION")
    private fun ownCertificates(): Set<String> {
        val pm = context.packageManager
        val info: PackageInfo = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(signatureFlag().toLong()))
            } else {
                pm.getPackageInfo(context.packageName, signatureFlag())
            }
        } catch (e: PackageManager.NameNotFoundException) {
            return emptySet()
        }
        return certHashes(info)
    }

    @Suppress("DEPRECATION")
    private fun signatureFlag(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun certHashes(info: PackageInfo): Set<String> {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            info.signatures
        }
        return sigs.orEmpty().map { Hashing.sha256Hex(it.toByteArray()) }.toSet()
    }
}
