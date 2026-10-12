package com.attendance.kiosk.core.update

import com.attendance.kiosk.core.api.LatestReleaseResponse
import com.attendance.kiosk.core.api.ReleaseInfo
import com.attendance.kiosk.core.crypto.Hashing
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class UpdatePolicyTest {
    private val cert = "a1".repeat(32)
    private val otherCert = "b2".repeat(32)
    private val apkSha = "c3".repeat(32)
    private val pkg = "com.attendance.kiosk"

    private fun release(code: Int = 12, url: String = "https://downloads.example.com/kiosk-1.2.0.apk", min: Int = 0) =
        ReleaseInfo(code, "1.2.0", url, apkSha, cert, min, "Faster recognition", "2026-10-01T00:00:00Z")

    // --- decide ---------------------------------------------------------------------------

    @Test
    fun `no release or older release is up to date`() {
        assertEquals(UpdateDecision.UpToDate, UpdatePolicy.decide(10, LatestReleaseResponse(null)))
        assertEquals(UpdateDecision.UpToDate, UpdatePolicy.decide(12, LatestReleaseResponse(release(12), updateAvailable = false)))
        assertEquals(UpdateDecision.UpToDate, UpdatePolicy.decide(13, LatestReleaseResponse(release(12))))
    }

    @Test
    fun `newer release is available, mandatory below min supported`() {
        val d = assertIs<UpdateDecision.Available>(UpdatePolicy.decide(10, LatestReleaseResponse(release(12), true, false)))
        assertEquals(false, d.mandatory)
        val m = assertIs<UpdateDecision.Available>(UpdatePolicy.decide(10, LatestReleaseResponse(release(12, min = 11), true, false)))
        assertEquals(true, m.mandatory)
        assertEquals(true, assertIs<UpdateDecision.Available>(UpdatePolicy.decide(10, LatestReleaseResponse(release(12), true, true))).mandatory)
    }

    @Test
    fun `http apk url or malformed hashes are refused`() {
        assertIs<UpdateDecision.Invalid>(UpdatePolicy.decide(1, LatestReleaseResponse(release(url = "http://x.example.com/a.apk"))))
        assertIs<UpdateDecision.Invalid>(UpdatePolicy.decide(1, LatestReleaseResponse(release().copy(apkSha256 = "abc"))))
        assertIs<UpdateDecision.Invalid>(UpdatePolicy.decide(1, LatestReleaseResponse(release().copy(signingCertSha256 = ""))))
    }

    // --- verifyApk ------------------------------------------------------------------------

    private fun verify(
        rel: ReleaseInfo = release(),
        fileSha: String = apkSha,
        facts: ApkFacts? = ApkFacts(pkg, 12, setOf(cert)),
        ownVersion: Long = 10,
        own: Set<String> = setOf(cert),
    ) = UpdatePolicy.verifyApk(rel, fileSha, facts, pkg, ownVersion, own)

    private fun rejected(v: ApkVerdict) = assertIs<ApkVerdict.Reject>(v).reason

    @Test
    fun `accepts only when everything matches`() {
        assertEquals(ApkVerdict.Accept, verify())
        // Formatting differences in hex are tolerated.
        assertEquals(ApkVerdict.Accept, verify(fileSha = apkSha.uppercase(), own = setOf(cert.chunked(2).joinToString(":").uppercase())))
    }

    @Test
    fun `rejections`() {
        assertEquals(RejectReason.HASH_MISMATCH, rejected(verify(fileSha = "d4".repeat(32))))
        assertEquals(RejectReason.UNREADABLE_APK, rejected(verify(facts = null)))
        assertEquals(RejectReason.PACKAGE_MISMATCH, rejected(verify(facts = ApkFacts("com.evil.app", 12, setOf(cert)))))
        assertEquals(RejectReason.VERSION_MISMATCH, rejected(verify(facts = ApkFacts(pkg, 11, setOf(cert)))))
        assertEquals(RejectReason.NOT_NEWER, rejected(verify(rel = release(10), facts = ApkFacts(pkg, 10, setOf(cert)))))
        assertEquals(RejectReason.NO_SIGNATURE, rejected(verify(facts = ApkFacts(pkg, 12, emptySet()))))
        assertEquals(RejectReason.INSECURE_URL, rejected(verify(rel = release(url = "http://example.com/a.apk"))))
    }

    @Test
    fun `apk signed by another key is rejected even if the server lists that key`() {
        // Compromised server publishes an attacker-signed APK and the attacker's cert.
        val rel = release().copy(signingCertSha256 = otherCert)
        assertEquals(RejectReason.CERT_NOT_OWN, rejected(verify(rel = rel, facts = ApkFacts(pkg, 12, setOf(otherCert)))))
    }

    @Test
    fun `apk signed by our key but not the published cert is rejected`() {
        val rel = release().copy(signingCertSha256 = otherCert)
        assertEquals(RejectReason.CERT_NOT_SERVER, rejected(verify(rel = rel)))
    }

    @Test
    fun `extra signer is rejected`() {
        assertEquals(RejectReason.CERT_NOT_OWN, rejected(verify(facts = ApkFacts(pkg, 12, setOf(cert, otherCert)))))
    }

    // --- downloader -----------------------------------------------------------------------

    @Test
    fun `downloader streams to file and reports sha256, refuses http by default`() {
        val server = MockWebServer()
        val payload = ByteArray(200_000) { (it % 251).toByte() }
        server.enqueue(MockResponse().setBody(Buffer().write(payload)))
        server.start()
        val dir = Files.createTempDirectory("dl").toFile()
        try {
            val refused = ApkDownloader(OkHttpClient()).download(server.url("/a.apk").toString(), dir.resolve("a.apk"))
            assertIs<DownloadResult.Failed>(refused)
            val ok = assertIs<DownloadResult.Ok>(ApkDownloader(OkHttpClient(), allowInsecure = true).download(server.url("/a.apk").toString(), dir.resolve("a.apk")))
            assertEquals(Hashing.sha256Hex(payload), ok.sha256)
            assertEquals(payload.size.toLong(), ok.file.length())
            assertTrue(dir.listFiles()!!.none { it.name.endsWith(".part") })
        } finally {
            server.shutdown()
            dir.deleteRecursively()
        }
    }

    @Test
    fun `downloader reports http errors`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(404))
        server.start()
        val dir = Files.createTempDirectory("dl").toFile()
        try {
            val r = ApkDownloader(OkHttpClient(), allowInsecure = true).download(server.url("/a.apk").toString(), dir.resolve("a.apk"))
            assertTrue(assertIs<DownloadResult.Failed>(r).message.contains("404"))
        } finally {
            server.shutdown()
            dir.deleteRecursively()
        }
    }
}
