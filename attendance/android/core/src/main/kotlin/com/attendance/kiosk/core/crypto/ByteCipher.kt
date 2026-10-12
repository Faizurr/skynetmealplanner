package com.attendance.kiosk.core.crypto

import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Authenticated encryption of small blobs. [aad] binds a ciphertext to its purpose/file name. */
interface ByteCipher {
    fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray

    /** @throws GeneralSecurityException if the data was tampered with or the key changed. */
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a random 96-bit IV chosen by the cipher provider (required by the Android
 * Keystore, which refuses caller-supplied IVs by default). Layout: [version=1][ivLen][iv][ciphertext+tag].
 * On Android the key lives in the Android Keystore and never leaves secure hardware/TEE.
 */
class AesGcmByteCipher(private val keyProvider: () -> SecretKey) : ByteCipher {
    override fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, keyProvider())
        c.updateAAD(aad)
        val ct = c.doFinal(plain)
        val iv = c.iv
        return ByteBuffer.allocate(2 + iv.size + ct.size).put(VERSION).put(iv.size.toByte()).put(iv).put(ct).array()
    }

    override fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
        if (blob.size < 2 + 12 + 16 || blob[0] != VERSION) throw GeneralSecurityException("unsupported blob format")
        val ivLen = blob[1].toInt()
        if (ivLen !in 12..16 || blob.size < 2 + ivLen + 16) throw GeneralSecurityException("bad iv length")
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return c.doFinal(blob, 2 + ivLen, blob.size - 2 - ivLen)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val VERSION: Byte = 1
    }
}

object Hashing {
    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    fun sha256Hex(input: java.io.InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().toHex()
    }

    fun sha256Hex(file: java.io.File): String = file.inputStream().use { sha256Hex(it) }

    fun ByteArray.toHex(): String {
        val sb = StringBuilder(size * 2)
        for (b in this) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    /** Lower-case hex without separators, so "AB:CD" and "abcd" compare equal. */
    fun normalizeHex(s: String): String = s.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }

    private val HEX = "0123456789abcdef".toCharArray()
}
