package com.attendance.kiosk.core.update

import com.attendance.kiosk.core.api.LatestReleaseResponse
import com.attendance.kiosk.core.api.ReleaseInfo
import com.attendance.kiosk.core.crypto.Hashing
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

sealed interface UpdateDecision {
    data object UpToDate : UpdateDecision
    data class Available(val release: ReleaseInfo, val mandatory: Boolean) : UpdateDecision
    data class Invalid(val reason: String) : UpdateDecision
}

/** Facts read from a downloaded APK with PackageManager.getPackageArchiveInfo. */
data class ApkFacts(
    val packageName: String?,
    val versionCode: Long?,
    /** SHA-256 (hex) of each certificate that signed the APK contents. */
    val signerCertSha256: Set<String>,
)

enum class RejectReason {
    INSECURE_URL, HASH_MISMATCH, UNREADABLE_APK, PACKAGE_MISMATCH, VERSION_MISMATCH, NOT_NEWER,
    NO_SIGNATURE, CERT_NOT_SERVER, CERT_NOT_OWN,
}

sealed interface ApkVerdict {
    data object Accept : ApkVerdict
    data class Reject(val reason: RejectReason, val message: String) : ApkVerdict
}

/**
 * Update rules. A downloaded APK is handed to the system installer only if ALL hold:
 * HTTPS URL, file SHA-256 == release.apk_sha256, package name == ours, version code == the
 * release's and > ours, and the signing certificate equals BOTH the server's
 * signing_cert_sha256 AND the certificate of the running app.
 */
object UpdatePolicy {
    fun decide(currentVersionCode: Int, resp: LatestReleaseResponse): UpdateDecision {
        val rel = resp.release ?: return UpdateDecision.UpToDate
        if (rel.versionCode <= currentVersionCode) return UpdateDecision.UpToDate
        if (!isHttps(rel.apkUrl)) return UpdateDecision.Invalid("The update URL is not HTTPS")
        if (Hashing.normalizeHex(rel.apkSha256).length != 64) return UpdateDecision.Invalid("The update has no valid SHA-256")
        if (Hashing.normalizeHex(rel.signingCertSha256).length != 64) return UpdateDecision.Invalid("The update has no valid signing certificate")
        val mandatory = resp.mandatory || currentVersionCode < rel.minSupportedVersionCode
        return UpdateDecision.Available(rel, mandatory)
    }

    fun isHttps(url: String): Boolean = url.toHttpUrlOrNull()?.isHttps == true

    fun verifyApk(
        release: ReleaseInfo,
        fileSha256: String,
        apk: ApkFacts?,
        ownPackage: String,
        ownVersionCode: Long,
        ownCertSha256: Set<String>,
    ): ApkVerdict {
        if (!isHttps(release.apkUrl)) return ApkVerdict.Reject(RejectReason.INSECURE_URL, "The download link is not secure (HTTPS required).")
        if (Hashing.normalizeHex(fileSha256) != Hashing.normalizeHex(release.apkSha256)) {
            return ApkVerdict.Reject(RejectReason.HASH_MISMATCH, "The downloaded file does not match the published checksum.")
        }
        if (apk == null) return ApkVerdict.Reject(RejectReason.UNREADABLE_APK, "The downloaded file is not a valid Android app.")
        if (apk.packageName != ownPackage) {
            return ApkVerdict.Reject(RejectReason.PACKAGE_MISMATCH, "The download is a different app (${apk.packageName}).")
        }
        val vc = apk.versionCode ?: return ApkVerdict.Reject(RejectReason.UNREADABLE_APK, "The app version could not be read.")
        if (vc != release.versionCode.toLong()) {
            return ApkVerdict.Reject(RejectReason.VERSION_MISMATCH, "The app version ($vc) differs from the release (${release.versionCode}).")
        }
        if (vc <= ownVersionCode) return ApkVerdict.Reject(RejectReason.NOT_NEWER, "This version is not newer than the installed one.")
        val apkCerts = apk.signerCertSha256.map(Hashing::normalizeHex).toSet()
        val own = ownCertSha256.map(Hashing::normalizeHex).toSet()
        if (apkCerts.isEmpty() || apkCerts.any { it.length != 64 }) {
            return ApkVerdict.Reject(RejectReason.NO_SIGNATURE, "The app's signature could not be verified.")
        }
        if (Hashing.normalizeHex(release.signingCertSha256) !in apkCerts) {
            return ApkVerdict.Reject(RejectReason.CERT_NOT_SERVER, "The app is not signed with the published certificate.")
        }
        if (apkCerts != own) {
            return ApkVerdict.Reject(RejectReason.CERT_NOT_OWN, "The app is signed with a different key than the installed app.")
        }
        return ApkVerdict.Accept
    }
}
