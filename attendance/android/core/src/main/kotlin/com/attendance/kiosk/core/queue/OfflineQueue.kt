package com.attendance.kiosk.core.queue

import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.AttendanceRequest
import com.attendance.kiosk.core.api.AttendanceResult
import com.attendance.kiosk.core.api.KioskJson
import com.attendance.kiosk.core.api.Method
import com.attendance.kiosk.core.api.describe
import com.attendance.kiosk.core.crypto.SecureBlobStore
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One face attendance captured while offline. PINs are never queued. */
@Serializable
data class QueueEntry(
    @SerialName("event_id") val eventId: String,
    val action: Action,
    val method: Method = Method.FACE,
    @SerialName("employee_id") val employeeId: String,
    /** Probe embedding (base64). Removed as soon as the entry is synced or permanently fails. */
    val embedding: String?,
    @SerialName("match_score") val matchScore: Double,
    @SerialName("liveness_passed") val livenessPassed: Boolean,
    /** ISO timestamp sent to the server. */
    @SerialName("device_timestamp") val deviceTimestamp: String,
    /** Same instant as epoch ms; the replay order key. */
    @SerialName("device_time_ms") val deviceTimeMs: Long,
    /** Local name, for the manager's queue screen only (never sent). */
    @SerialName("employee_name") val employeeName: String? = null,
    /** Monotonic tie-breaker for identical device times. */
    val seq: Long = 0,
) {
    fun toRequest(): AttendanceRequest = AttendanceRequest(
        eventId = eventId,
        action = action,
        method = method,
        employeeId = employeeId,
        embedding = embedding,
        matchScore = matchScore,
        livenessPassed = livenessPassed,
        deviceTimestamp = deviceTimestamp,
        offline = true,
    )
}

@Serializable
enum class QueueStatus { @SerialName("pending") PENDING, @SerialName("failed") FAILED }

@Serializable
data class QueueRecord(
    val entry: QueueEntry,
    val status: QueueStatus = QueueStatus.PENDING,
    val attempts: Int = 0,
    @SerialName("next_attempt_at_ms") val nextAttemptAtMs: Long = 0,
    @SerialName("last_error") val lastError: String? = null,
    @SerialName("failed_reason") val failedReason: String? = null,
    @SerialName("failed_code") val failedCode: String? = null,
    @SerialName("failed_at_ms") val failedAtMs: Long? = null,
)

/** Persistence for queue records, one record per event id. */
interface QueueStore {
    fun list(): List<QueueRecord>
    fun get(eventId: String): QueueRecord?
    fun put(record: QueueRecord)
    fun delete(eventId: String)
}

class InMemoryQueueStore : QueueStore {
    private val map = LinkedHashMap<String, QueueRecord>()
    @Synchronized override fun list() = map.values.toList()
    @Synchronized override fun get(eventId: String) = map[eventId]
    @Synchronized override fun put(record: QueueRecord) { map[record.entry.eventId] = record }
    @Synchronized override fun delete(eventId: String) { map.remove(eventId) }
}

/** Encrypted at rest, one file per event, written atomically (temp file + rename). */
class EncryptedQueueStore(private val blobs: SecureBlobStore) : QueueStore {
    private val uuid = Regex("^[0-9a-fA-F-]{36}$")
    private fun name(eventId: String): String {
        require(uuid.matches(eventId)) { "event id must be a UUID" }
        return "evt-$eventId"
    }

    override fun list(): List<QueueRecord> = blobs.names().filter { it.startsWith("evt-") }.mapNotNull { n ->
        blobs.readText(n)?.let { runCatching { KioskJson.decodeFromString(QueueRecord.serializer(), it) }.getOrNull() }
    }

    override fun get(eventId: String): QueueRecord? =
        blobs.readText(name(eventId))?.let { runCatching { KioskJson.decodeFromString(QueueRecord.serializer(), it) }.getOrNull() }

    override fun put(record: QueueRecord) =
        blobs.writeText(name(record.entry.eventId), KioskJson.encodeToString(QueueRecord.serializer(), record))

    override fun delete(eventId: String) {
        blobs.delete(name(eventId))
    }
}

/** What to do with a queued event after one upload attempt (docs/API.md "replaying offline events"). */
enum class SyncDisposition { DONE, PERMANENT_FAILURE, RETRY, DEVICE_REVOKED }

object SyncClassifier {
    fun classify(result: ApiResult<*>): SyncDisposition = when (result) {
        is ApiResult.Ok -> SyncDisposition.DONE
        is ApiResult.Network -> SyncDisposition.RETRY
        is ApiResult.Http -> when {
            result.isDeviceRevoked -> SyncDisposition.DEVICE_REVOKED
            result.status == 408 || result.status == 429 -> SyncDisposition.RETRY
            result.status in 400..499 -> SyncDisposition.PERMANENT_FAILURE
            else -> SyncDisposition.RETRY
        }
    }
}

object Backoff {
    const val BASE_MS = 30_000L
    const val MAX_MS = 30L * 60_000L

    /** 30 s, 60 s, 2 min, 4 min … capped at 30 min. [attempts] counts failed attempts so far (≥1). */
    fun delayMs(attempts: Int): Long {
        val shift = (attempts - 1).coerceIn(0, 20)
        return minOf(MAX_MS, BASE_MS shl shift)
    }
}

data class SyncReport(
    val synced: Int = 0,
    val failed: Int = 0,
    val retryScheduled: Boolean = false,
    val deviceRevoked: Boolean = false,
    val lastError: String? = null,
    val remaining: Int = 0,
)

data class QueueCounts(val pending: Int, val failed: Int)

/**
 * Offline queue. Replays pending events strictly in device-time order; a retryable failure
 * stops the pass so later events never overtake earlier ones for the same employee.
 */
class OfflineQueue(private val store: QueueStore) {
    private var seq = System.currentTimeMillis() * 1000

    /** Adds an entry. Returns false if an entry with the same event id already exists (dedupe). */
    @Synchronized
    fun enqueue(entry: QueueEntry): Boolean {
        if (store.get(entry.eventId) != null) return false
        store.put(QueueRecord(entry.copy(seq = ++seq)))
        return true
    }

    @Synchronized
    fun contains(eventId: String): Boolean = store.get(eventId) != null

    @Synchronized
    fun pending(): List<QueueRecord> = store.list().filter { it.status == QueueStatus.PENDING }
        .sortedWith(compareBy<QueueRecord>({ it.entry.deviceTimeMs }, { it.entry.seq }))

    @Synchronized
    fun failed(): List<QueueRecord> = store.list().filter { it.status == QueueStatus.FAILED }
        .sortedByDescending { it.failedAtMs ?: 0L }

    @Synchronized
    fun counts(): QueueCounts {
        val all = store.list()
        return QueueCounts(all.count { it.status == QueueStatus.PENDING }, all.count { it.status == QueueStatus.FAILED })
    }

    /** Next time a pending entry is due, or null if nothing is pending. */
    @Synchronized
    fun nextDueAtMs(): Long? = pending().firstOrNull()?.nextAttemptAtMs

    @Synchronized
    fun clearFailed(): Int {
        val f = failed()
        f.forEach { store.delete(it.entry.eventId) }
        return f.size
    }

    /**
     * Uploads due entries in order using [send] (blocking). [force] ignores backoff (manual "Sync now"
     * or a connectivity change). [onSynced] is told about each server-accepted entry.
     */
    @Synchronized
    fun syncOnce(
        nowMs: Long,
        force: Boolean = false,
        onSynced: (QueueEntry, AttendanceResult) -> Unit = { _, _ -> },
        send: (AttendanceRequest) -> ApiResult<AttendanceResult>,
    ): SyncReport {
        var synced = 0
        var failed = 0
        var lastError: String? = null
        for (rec in pending()) {
            if (!force && rec.nextAttemptAtMs > nowMs) {
                return SyncReport(synced, failed, retryScheduled = true, lastError = lastError, remaining = pending().size)
            }
            val result = send(rec.entry.toRequest())
            when (SyncClassifier.classify(result)) {
                SyncDisposition.DONE -> {
                    // Deleting the record also deletes the stored embedding.
                    store.delete(rec.entry.eventId)
                    synced++
                    onSynced(rec.entry, (result as ApiResult.Ok).value)
                }
                SyncDisposition.PERMANENT_FAILURE -> {
                    val http = result as ApiResult.Http
                    store.put(
                        rec.copy(
                            entry = rec.entry.copy(embedding = null),
                            status = QueueStatus.FAILED,
                            attempts = rec.attempts + 1,
                            failedCode = http.code,
                            failedReason = http.message ?: http.code,
                            failedAtMs = nowMs,
                            lastError = result.describe(),
                        ),
                    )
                    failed++
                    lastError = result.describe()
                }
                SyncDisposition.RETRY -> {
                    val attempts = rec.attempts + 1
                    store.put(rec.copy(attempts = attempts, nextAttemptAtMs = nowMs + Backoff.delayMs(attempts), lastError = result.describe()))
                    return SyncReport(synced, failed, retryScheduled = true, lastError = result.describe(), remaining = pending().size)
                }
                SyncDisposition.DEVICE_REVOKED -> {
                    return SyncReport(synced, failed, deviceRevoked = true, lastError = result.describe(), remaining = pending().size)
                }
            }
        }
        return SyncReport(synced, failed, lastError = lastError, remaining = 0)
    }
}
