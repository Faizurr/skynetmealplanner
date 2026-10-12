package com.attendance.kiosk.data

import android.os.Build
import android.util.Log
import com.attendance.kiosk.BuildConfig
import com.attendance.kiosk.core.api.ApiResult
import com.attendance.kiosk.core.api.AttendanceRequest
import com.attendance.kiosk.core.api.AttendanceResult
import com.attendance.kiosk.core.api.EnrollmentRequest
import com.attendance.kiosk.core.api.EnrollmentResponse
import com.attendance.kiosk.core.api.HeartbeatRequest
import com.attendance.kiosk.core.api.KioskApi
import com.attendance.kiosk.core.api.KioskConfig
import com.attendance.kiosk.core.api.LatestReleaseResponse
import com.attendance.kiosk.core.api.ManagerEmployeesResponse
import com.attendance.kiosk.core.api.ManagerLoginRequest
import com.attendance.kiosk.core.api.ManagerLoginResponse
import com.attendance.kiosk.core.api.PairRequest
import com.attendance.kiosk.core.api.TemplatesFetch
import com.attendance.kiosk.core.api.UnknownFaceRequest
import com.attendance.kiosk.core.api.VerifyRequest
import com.attendance.kiosk.core.api.VerifyResponse
import com.attendance.kiosk.core.api.describe
import com.attendance.kiosk.core.api.Action
import com.attendance.kiosk.core.face.Matcher
import com.attendance.kiosk.core.face.TemplateSet
import com.attendance.kiosk.core.flow.LastAction
import com.attendance.kiosk.core.format.DisplayFormat
import com.attendance.kiosk.core.queue.OfflineQueue
import com.attendance.kiosk.core.queue.QueueCounts
import com.attendance.kiosk.core.queue.SyncReport
import com.attendance.kiosk.net.ConnectivityMonitor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the UI needs to know about the pairing. */
sealed interface PairingState {
    data object Unpaired : PairingState
    /** The server revoked this device (401 device_revoked); it must be paired again. */
    data object Revoked : PairingState
    data class Paired(val credentials: Credentials) : PairingState
}

/**
 * Single source of truth for server data, caches and background work (heartbeat, config and
 * template refresh, offline sync). All network calls are blocking OkHttp calls and must run on
 * an IO dispatcher.
 */
class KioskRepository(
    private val stores: LocalStores,
    val queue: OfflineQueue,
    private val clearQueue: () -> Unit,
    private val connectivity: ConnectivityMonitor,
    private val scope: CoroutineScope,
) {
    private companion object {
        const val TAG = "KioskRepository"
        const val HEARTBEAT_MS = 60_000L
        const val REFRESH_MS = 5 * 60_000L
        const val SYNC_MS = 30_000L
    }

    private val baseClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** Employees wait for this one: fail fast so the offline path kicks in quickly. */
    private val attendanceClient: OkHttpClient = baseClient.newBuilder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .build()

    val downloadClient: OkHttpClient = baseClient.newBuilder().callTimeout(10, TimeUnit.MINUTES).readTimeout(60, TimeUnit.SECONDS).build()

    private val _pairing = MutableStateFlow<PairingState>(stores.credentials()?.let { PairingState.Paired(it) } ?: PairingState.Unpaired)
    val pairing: StateFlow<PairingState> = _pairing.asStateFlow()

    private val _config = MutableStateFlow(stores.config())
    val config: StateFlow<KioskConfig?> = _config.asStateFlow()

    private val _templates = MutableStateFlow(stores.templates()?.let { Matcher.decodeTemplates(it.response) } ?: emptyList())
    val templates: StateFlow<List<TemplateSet>> = _templates.asStateFlow()

    /** Server reachable according to the last request (combined with system connectivity in the UI). */
    private val _reachable = MutableStateFlow(true)
    val reachable: StateFlow<Boolean> = _reachable.asStateFlow()
    val systemOnline: StateFlow<Boolean> get() = connectivity.online

    private val _counts = MutableStateFlow(safeCounts())
    val counts: StateFlow<QueueCounts> = _counts.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val _lastSyncMs = MutableStateFlow(stores.prefs().lastSyncMs)
    val lastSyncMs: StateFlow<Long> = _lastSyncMs.asStateFlow()

    private val _soundOverride = MutableStateFlow(stores.prefs().soundOverride)
    val soundOverride: StateFlow<Boolean?> = _soundOverride.asStateFlow()

    private val syncMutex = Mutex()
    private var loops: Job? = null

    // --- API access ---------------------------------------------------------------------

    private fun api(client: OkHttpClient = baseClient): KioskApi? {
        val creds = (pairing.value as? PairingState.Paired)?.credentials ?: return null
        val url = KioskApi.parseBaseUrl(creds.serverUrl) ?: return null
        return KioskApi(url, client) { creds.deviceToken }
    }

    private fun <T> track(r: ApiResult<T>): ApiResult<T> {
        when (r) {
            is ApiResult.Ok -> _reachable.value = true
            is ApiResult.Http -> {
                _reachable.value = !r.isServerError
                if (r.isDeviceRevoked) onDeviceRevoked()
            }
            is ApiResult.Network -> {
                _reachable.value = false
                _lastError.value = r.describe()
            }
        }
        return r
    }

    private fun notPaired(): ApiResult.Network = ApiResult.Network(IOException("Device is not paired"))

    // --- Pairing ------------------------------------------------------------------------

    fun pair(serverUrl: String, code: String): ApiResult<Unit> {
        val base = KioskApi.parseBaseUrl(serverUrl) ?: return ApiResult.Network(IOException("Invalid server address"))
        val api = KioskApi(base, baseClient) { null }
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120)
        return when (val r = api.pair(PairRequest(code, model, BuildConfig.VERSION_NAME))) {
            is ApiResult.Ok -> {
                stores.clearPairing()
                val creds = Credentials(base.toString().trimEnd('/'), r.value.deviceId, r.value.deviceToken)
                stores.saveCredentials(creds)
                _config.value = null
                _templates.value = emptyList()
                _counts.value = safeCounts()
                _pairing.value = PairingState.Paired(creds)
                _reachable.value = true
                startLoops()
                ApiResult.Ok(Unit)
            }
            is ApiResult.Http -> r
            is ApiResult.Network -> r
        }
    }

    /** Manager-initiated unpair: forget the token, caches, queue and local state. */
    fun unpair() {
        loops?.cancel()
        clearQueue()
        stores.clearPairing()
        _config.value = null
        _templates.value = emptyList()
        _counts.value = safeCounts()
        _pairing.value = PairingState.Unpaired
    }

    private fun onDeviceRevoked() {
        if (pairing.value !is PairingState.Paired) return
        Log.w(TAG, "Device revoked by server")
        loops?.cancel()
        // Forget the token and caches. The offline queue stays on disk so that records captured
        // before the revocation can still be replayed if the device is re-paired.
        stores.clearPairing()
        _pairing.value = PairingState.Revoked
    }

    // --- Config & templates ---------------------------------------------------------------

    fun refreshConfig(): ApiResult<KioskConfig> {
        val api = api() ?: return notPaired()
        val r = track(api.config())
        if (r is ApiResult.Ok) {
            _config.value = r.value
            runCatching { stores.saveConfig(r.value) }
        }
        return r
    }

    fun refreshTemplates(): ApiResult<TemplatesFetch> {
        val api = api() ?: return notPaired()
        val cached = stores.templates()
        val r = track(api.templates(if (_templates.value.isEmpty()) null else cached?.etag))
        if (r is ApiResult.Ok) {
            val v = r.value
            if (v is TemplatesFetch.Updated) {
                _templates.value = Matcher.decodeTemplates(v.response)
                runCatching { stores.saveTemplates(CachedTemplates(v.etag, v.response)) }
            }
        }
        return r
    }

    fun refreshAll() {
        refreshConfig()
        refreshTemplates()
    }

    // --- Attendance -------------------------------------------------------------------------

    fun submitAttendance(req: AttendanceRequest): ApiResult<AttendanceResult> {
        // Known-offline: don't make the employee wait for a timeout.
        if (!connectivity.online.value) return ApiResult.Network(IOException("No internet connection"))
        val api = api(attendanceClient) ?: return notPaired()
        return track(api.attendance(req))
    }

    fun reportUnknownFace(action: Action, bestScore: Double?) {
        val api = api() ?: return
        track(api.unknownFace(UnknownFaceRequest(action, bestScore?.coerceIn(-1.0, 1.0))))
    }

    // --- Offline sync -------------------------------------------------------------------------

    suspend fun syncNow(force: Boolean): SyncReport? = syncMutex.withLock {
        val api = api() ?: return null
        if (queue.counts().pending == 0) {
            _counts.value = safeCounts()
            return SyncReport()
        }
        val report = queue.syncOnce(System.currentTimeMillis(), force, onSynced = { entry, result ->
            val at = DisplayFormat.parseInstant(result.event.eventTime)?.toEpochMilli() ?: entry.deviceTimeMs
            val current = stores.lastActions.get(entry.employeeId)
            if (current == null || current.atMs <= at) stores.lastActions.put(entry.employeeId, LastAction(entry.action, at))
        }) { req -> track(api.attendance(req)) }
        if (report.deviceRevoked) onDeviceRevoked()
        if (report.synced > 0) {
            val now = System.currentTimeMillis()
            _lastSyncMs.value = now
            runCatching { stores.updatePrefs { it.copy(lastSyncMs = now) } }
        }
        report.lastError?.let { _lastError.value = it }
        _counts.value = safeCounts()
        report
    }

    fun refreshCounts() {
        _counts.value = safeCounts()
    }

    fun clearFailed(): Int = queue.clearFailed().also { _counts.value = safeCounts() }

    private fun safeCounts(): QueueCounts = runCatching { queue.counts() }.getOrDefault(QueueCounts(0, 0))

    // --- Heartbeat ------------------------------------------------------------------------------

    fun heartbeat(): ApiResult<*> {
        val api = api() ?: return notPaired()
        val c = safeCounts()
        return track(
            api.heartbeat(
                HeartbeatRequest(
                    appVersion = BuildConfig.VERSION_NAME,
                    appVersionCode = BuildConfig.VERSION_CODE,
                    pendingQueueCount = c.pending,
                    failedQueueCount = c.failed,
                    lastError = _lastError.value?.take(500),
                    synced = c.pending == 0,
                ),
            ),
        )
    }

    // --- Manager ----------------------------------------------------------------------------------

    fun managerLogin(email: String, password: String): ApiResult<ManagerLoginResponse> =
        api()?.let { track(it.managerLogin(ManagerLoginRequest(email.trim(), password))) } ?: notPaired()

    fun managerEmployees(token: String): ApiResult<ManagerEmployeesResponse> =
        api()?.let { track(it.managerEmployees(token)) } ?: notPaired()

    fun enroll(token: String, req: EnrollmentRequest): ApiResult<EnrollmentResponse> =
        api()?.let { track(it.enroll(token, req)) } ?: notPaired()

    fun verify(token: String, embedding: String): ApiResult<VerifyResponse> =
        api()?.let { track(it.verify(token, VerifyRequest(embedding))) } ?: notPaired()

    fun latestRelease(): ApiResult<LatestReleaseResponse> =
        api()?.let { track(it.latestRelease(BuildConfig.VERSION_CODE)) } ?: notPaired()

    // --- Local settings ---------------------------------------------------------------------------

    fun setSoundOverride(value: Boolean?) {
        runCatching { stores.updatePrefs { it.copy(soundOverride = value) } }
        _soundOverride.value = value
    }

    fun lastUpdateCheckMs(): Long = stores.prefs().lastUpdateCheckMs
    fun markUpdateChecked(now: Long) {
        runCatching { stores.updatePrefs { it.copy(lastUpdateCheckMs = now) } }
    }

    // --- Background loops -------------------------------------------------------------------------

    /** Starts heartbeat / refresh / sync loops (idempotent). [onDailyUpdateCheck] runs about daily. */
    fun startLoops(onDailyUpdateCheck: (suspend () -> Unit)? = dailyUpdateCheck) {
        dailyUpdateCheck = onDailyUpdateCheck
        if (loops?.isActive == true) return
        if (pairing.value !is PairingState.Paired) return
        loops = scope.launch {
            launch {
                while (isActive) {
                    runCatching { refreshAll() }.onFailure { Log.w(TAG, "refresh failed", it) }
                    delay(REFRESH_MS)
                }
            }
            launch {
                delay(5_000)
                while (isActive) {
                    runCatching { heartbeat() }.onFailure { Log.w(TAG, "heartbeat failed", it) }
                    delay(HEARTBEAT_MS)
                }
            }
            launch {
                while (isActive) {
                    runCatching { syncNow(force = false) }.onFailure { Log.w(TAG, "sync failed", it) }
                    delay(SYNC_MS)
                }
            }
            launch {
                // Connectivity regained: sync immediately (ignoring backoff) and refresh.
                connectivity.online.drop(1).collect { online ->
                    if (online) {
                        runCatching { syncNow(force = true) }
                        runCatching { refreshAll() }
                        runCatching { heartbeat() }
                    }
                }
            }
            launch {
                delay(2 * 60_000L)
                while (isActive) {
                    val now = System.currentTimeMillis()
                    if (now - lastUpdateCheckMs() >= 24 * 3_600_000L) {
                        runCatching { dailyUpdateCheck?.invoke() }
                        markUpdateChecked(now)
                    }
                    delay(60 * 60_000L)
                }
            }
        }
    }

    @Volatile private var dailyUpdateCheck: (suspend () -> Unit)? = null
}
