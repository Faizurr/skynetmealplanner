package com.attendance.kiosk.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * AES-256-GCM key held in the Android Keystore (hardware-backed where available). The key
 * material never leaves the Keystore; it encrypts the device token, cached templates, the
 * offline queue and local state at rest.
 */
object KeystoreKeys {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "kiosk_storage_aes_v1"

    @Volatile private var cached: SecretKey? = null

    @Synchronized
    fun storageKey(): SecretKey {
        cached?.let { return it }
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        val existing = (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
        val key = existing ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
        cached = key
        return key
    }
}
