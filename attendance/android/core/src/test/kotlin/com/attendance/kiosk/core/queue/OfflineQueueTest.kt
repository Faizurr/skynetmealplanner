package com.attendance.kiosk.core.queue

import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.AttendanceEvent
import com.attendance.kiosk.core.api.AttendanceRequest
import com.attendance.kiosk.core.api.AttendanceResult
import com.attendance.kiosk.core.api.DisplayDto
import com.attendance.kiosk.core.api.EmployeeRef
import com.attendance.kiosk.core.api.ErrorBody
import com.attendance.kiosk.core.crypto.AesGcmByteCipher
import com.attendance.kiosk.core.crypto.SecureBlobStore
import java.io.File
import java.io.IOException
import java.nio.file.Files
import javax.crypto.KeyGenerator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OfflineQueueTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"

    private fun entry(n: Int, t: Long, action: Action = Action.CHECK_IN) = QueueEntry(
        eventId = id(n), action = action, employeeId = "emp", embedding = "EMB$n", matchScore = 0.8,
        livenessPassed = true, deviceTimestamp = java.time.Instant.ofEpochMilli(t).toString(), deviceTimeMs = t,
    )

    private fun ok(req: AttendanceRequest) = ApiResult.Ok(
        AttendanceResult(
            "recorded",
            AttendanceEvent(req.eventId, req.action, req.deviceTimestamp, "verified", recordedOffline = true),
            EmployeeRef("emp", "Sarah Lim"),
            display = DisplayDto("g", "h", "t", "d"),
        ),
    )

    @Test
    fun `replays in device time order regardless of insertion order`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(3, 3_000)); q.enqueue(entry(1, 1_000)); q.enqueue(entry(2, 2_000))
        val sent = mutableListOf<String>()
        val report = q.syncOnce(10_000) { sent += it.eventId; ok(it) }
        assertEquals(listOf(id(1), id(2), id(3)), sent)
        assertEquals(3, report.synced)
        assertEquals(QueueCounts(0, 0), q.counts())
    }

    @Test
    fun `replayed requests are marked offline and carry the device timestamp`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000))
        var req: AttendanceRequest? = null
        q.syncOnce(5_000) { req = it; ok(it) }
        assertTrue(req!!.offline)
        assertEquals("1970-01-01T00:00:01Z", req!!.deviceTimestamp)
        assertEquals("EMB1", req!!.embedding)
    }

    @Test
    fun `dedupes by event id`() {
        val q = OfflineQueue(InMemoryQueueStore())
        assertTrue(q.enqueue(entry(1, 1_000)))
        assertFalse(q.enqueue(entry(1, 5_000)))
        assertEquals(1, q.counts().pending)
    }

    @Test
    fun `classification - 2xx done, 4xx permanent, 408 429 5xx and IO retry, 401 revoked`() {
        fun http(s: Int, code: String = "x") = ApiResult.Http(s, ErrorBody(code))
        assertEquals(SyncDisposition.DONE, SyncClassifier.classify(ApiResult.Ok(Unit)))
        assertEquals(SyncDisposition.PERMANENT_FAILURE, SyncClassifier.classify(http(409, "already_checked_in")))
        assertEquals(SyncDisposition.PERMANENT_FAILURE, SyncClassifier.classify(http(422, "not_recognized")))
        assertEquals(SyncDisposition.PERMANENT_FAILURE, SyncClassifier.classify(http(403, "offline_disabled")))
        assertEquals(SyncDisposition.PERMANENT_FAILURE, SyncClassifier.classify(http(400, "validation_failed")))
        assertEquals(SyncDisposition.RETRY, SyncClassifier.classify(http(408)))
        assertEquals(SyncDisposition.RETRY, SyncClassifier.classify(http(429)))
        assertEquals(SyncDisposition.RETRY, SyncClassifier.classify(http(500)))
        assertEquals(SyncDisposition.RETRY, SyncClassifier.classify(http(503)))
        assertEquals(SyncDisposition.RETRY, SyncClassifier.classify(ApiResult.Network(IOException())))
        assertEquals(SyncDisposition.DEVICE_REVOKED, SyncClassifier.classify(http(401, "device_revoked")))
    }

    @Test
    fun `exponential backoff capped at 30 minutes`() {
        assertEquals(30_000, Backoff.delayMs(1))
        assertEquals(60_000, Backoff.delayMs(2))
        assertEquals(120_000, Backoff.delayMs(3))
        assertEquals(30 * 60_000L, Backoff.delayMs(10))
        assertEquals(30 * 60_000L, Backoff.delayMs(1000))
    }

    @Test
    fun `retryable failure stops the pass so later events never overtake earlier ones`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000)); q.enqueue(entry(2, 2_000))
        val sent = mutableListOf<String>()
        val r = q.syncOnce(10_000) { sent += it.eventId; ApiResult.Network(IOException("down")) }
        assertEquals(listOf(id(1)), sent)
        assertTrue(r.retryScheduled)
        assertEquals(2, r.remaining)
        val head = q.pending().first()
        assertEquals(1, head.attempts)
        assertEquals(10_000 + 30_000, head.nextAttemptAtMs)

        // Not due yet: nothing is sent.
        sent.clear()
        q.syncOnce(20_000) { sent += it.eventId; ok(it) }
        assertTrue(sent.isEmpty())

        // Forced (Sync now / connectivity regained): sends in order.
        q.syncOnce(20_000, force = true) { sent += it.eventId; ok(it) }
        assertEquals(listOf(id(1), id(2)), sent)
    }

    @Test
    fun `second consecutive failure doubles the delay`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000))
        q.syncOnce(0) { ApiResult.Http(502, null) }
        q.syncOnce(30_000) { ApiResult.Http(502, null) }
        assertEquals(2, q.pending().single().attempts)
        assertEquals(30_000 + 60_000, q.pending().single().nextAttemptAtMs)
    }

    @Test
    fun `4xx moves the entry to the failed list with its reason and deletes the embedding`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000)); q.enqueue(entry(2, 2_000))
        val r = q.syncOnce(10_000) {
            if (it.eventId == id(1)) ApiResult.Http(409, ErrorBody("already_checked_in", "You are already checked in since 9:02 am.")) else ok(it)
        }
        assertEquals(1, r.synced); assertEquals(1, r.failed)
        val f = q.failed().single()
        assertEquals(QueueStatus.FAILED, f.status)
        assertEquals("already_checked_in", f.failedCode)
        assertEquals("You are already checked in since 9:02 am.", f.failedReason)
        assertNull(f.entry.embedding)
        assertEquals(QueueCounts(0, 1), q.counts())
        // Failed entries are not retried.
        var calls = 0
        q.syncOnce(99_000, force = true) { calls++; ok(it) }
        assertEquals(0, calls)
        assertEquals(1, q.clearFailed())
    }

    @Test
    fun `device revoked stops the pass without failing entries`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000))
        val r = q.syncOnce(10_000) { ApiResult.Http(401, ErrorBody("device_revoked")) }
        assertTrue(r.deviceRevoked)
        assertEquals(QueueCounts(1, 0), q.counts())
    }

    @Test
    fun `onSynced reports accepted entries`() {
        val q = OfflineQueue(InMemoryQueueStore())
        q.enqueue(entry(1, 1_000, Action.CHECK_OUT))
        val seen = mutableListOf<Action>()
        q.syncOnce(10_000, onSynced = { e, _ -> seen += e.action }) { ok(it) }
        assertEquals(listOf(Action.CHECK_OUT), seen)
    }

    @Test
    fun `encrypted store - one file per event, atomic, nothing readable on disk, embedding gone after sync`() {
        val dir = Files.createTempDirectory("queue").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val store = EncryptedQueueStore(SecureBlobStore(dir, AesGcmByteCipher { key }))
            val q = OfflineQueue(store)
            q.enqueue(entry(1, 1_000)); q.enqueue(entry(2, 2_000))
            val files = dir.listFiles()!!.filter { it.isFile }
            assertEquals(2, files.size)
            assertTrue(files.none { it.name.endsWith(".tmp") })
            files.forEach { f ->
                val raw = String(f.readBytes(), Charsets.ISO_8859_1)
                assertFalse(raw.contains("EMB"), "embedding must not be stored in clear text")
                assertFalse(raw.contains("emp"))
            }
            // A new queue instance (app restart) sees the same records.
            val q2 = OfflineQueue(EncryptedQueueStore(SecureBlobStore(dir, AesGcmByteCipher { key })))
            assertEquals(2, q2.counts().pending)
            q2.syncOnce(10_000) { ok(it) }
            assertEquals(0, dir.listFiles()!!.count { it.isFile })
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `tampered or foreign-key files are ignored rather than crashing`() {
        val dir = Files.createTempDirectory("queue").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val blobs = SecureBlobStore(dir, AesGcmByteCipher { key })
            val q = OfflineQueue(EncryptedQueueStore(blobs))
            q.enqueue(entry(1, 1_000))
            val f = dir.listFiles()!!.single()
            val bytes = f.readBytes(); bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte(); f.writeBytes(bytes)
            assertEquals(0, q.counts().pending)
            val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val other = OfflineQueue(EncryptedQueueStore(SecureBlobStore(dir, AesGcmByteCipher { otherKey })))
            assertEquals(0, other.counts().pending)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `encrypted store rejects non-uuid event ids (no path tricks)`() {
        val dir = Files.createTempDirectory("queue").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val store = EncryptedQueueStore(SecureBlobStore(dir, AesGcmByteCipher { key }))
            kotlin.test.assertFailsWith<IllegalArgumentException> { store.get("../../etc/passwd") }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Suppress("unused")
    private fun File.sizeOk() = length() > 0
}
