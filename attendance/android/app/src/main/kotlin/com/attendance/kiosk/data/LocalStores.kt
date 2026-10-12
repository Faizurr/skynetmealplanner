package com.attendance.kiosk.data

import com.attendance.kiosk.core.api.KioskConfig
import com.attendance.kiosk.core.api.KioskJson
import com.attendance.kiosk.core.api.TemplatesResponse
import com.attendance.kiosk.core.crypto.SecureBlobStore
import com.attendance.kiosk.core.flow.LastAction
import com.attendance.kiosk.core.flow.LastActionStore
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

@Serializable
data class Credentials(
    @SerialName("server_url") val serverUrl: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
)

@Serializable
data class CachedTemplates(val etag: String? = null, val response: TemplatesResponse)

@Serializable
data class LocalPrefs(
    /** null = follow the server's sound_enabled; true/false = local override from manager settings. */
    @SerialName("sound_override") val soundOverride: Boolean? = null,
    @SerialName("last_update_check_ms") val lastUpdateCheckMs: Long = 0,
    @SerialName("last_sync_ms") val lastSyncMs: Long = 0,
)

/** All small encrypted state of the kiosk, one encrypted file each. */
class LocalStores(private val blobs: SecureBlobStore) {
    private companion object {
        const val CREDENTIALS = "credentials"
        const val CONFIG = "config"
        const val TEMPLATES = "templates"
        const val PREFS = "prefs"
        const val LAST_ACTIONS = "last-actions"
    }

    fun credentials(): Credentials? = read(CREDENTIALS) { KioskJson.decodeFromString(Credentials.serializer(), it) }
    fun saveCredentials(c: Credentials) = blobs.writeText(CREDENTIALS, KioskJson.encodeToString(Credentials.serializer(), c))

    fun config(): KioskConfig? = read(CONFIG) { KioskJson.decodeFromString(KioskConfig.serializer(), it) }
    fun saveConfig(c: KioskConfig) = blobs.writeText(CONFIG, KioskJson.encodeToString(KioskConfig.serializer(), c))

    fun templates(): CachedTemplates? = read(TEMPLATES) { KioskJson.decodeFromString(CachedTemplates.serializer(), it) }
    fun saveTemplates(t: CachedTemplates) = blobs.writeText(TEMPLATES, KioskJson.encodeToString(CachedTemplates.serializer(), t))

    fun prefs(): LocalPrefs = read(PREFS) { KioskJson.decodeFromString(LocalPrefs.serializer(), it) } ?: LocalPrefs()

    @Synchronized
    fun updatePrefs(f: (LocalPrefs) -> LocalPrefs): LocalPrefs {
        val next = f(prefs())
        blobs.writeText(PREFS, KioskJson.encodeToString(LocalPrefs.serializer(), next))
        return next
    }

    /** Removes everything tied to the pairing (used on unpair / revoked device). */
    fun clearPairing() {
        blobs.names().forEach { blobs.delete(it) }
        lastActions.reset()
    }

    private fun <T> read(name: String, parse: (String) -> T): T? =
        blobs.readText(name)?.let { runCatching { parse(it) }.getOrNull() }

    /** Last action per employee, persisted encrypted (used for the offline wrong-action guard). */
    val lastActions = EncryptedLastActionStore()

    inner class EncryptedLastActionStore : LastActionStore {
        private val ser = MapSerializer(String.serializer(), LastAction.serializer())
        private var map: MutableMap<String, LastAction>? = null

        @Synchronized
        private fun load(): MutableMap<String, LastAction> =
            map ?: (read(LAST_ACTIONS) { KioskJson.decodeFromString(ser, it) }?.toMutableMap() ?: mutableMapOf()).also { map = it }

        @Synchronized
        override fun get(employeeId: String): LastAction? = load()[employeeId]

        @Synchronized
        override fun put(employeeId: String, value: LastAction) {
            val m = load()
            m[employeeId] = value
            // Keep the file small: forget entries older than two days.
            val cutoff = System.currentTimeMillis() - 48L * 3_600_000L
            m.entries.removeAll { it.value.atMs < cutoff }
            runCatching { blobs.writeText(LAST_ACTIONS, KioskJson.encodeToString(ser, m)) }
        }

        @Synchronized
        fun reset() {
            map = null
        }
    }
}
