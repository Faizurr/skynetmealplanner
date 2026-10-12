package com.attendance.kiosk.core.crypto

import java.nio.file.Files
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

class CryptoTest {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val cipher = AesGcmByteCipher { key }

    @Test
    fun `aes-gcm round trip with random iv`() {
        val a = cipher.encrypt("hello".toByteArray(), "name".toByteArray())
        val b = cipher.encrypt("hello".toByteArray(), "name".toByteArray())
        assertFalse(a.contentEquals(b), "IVs must differ")
        assertContentEquals("hello".toByteArray(), cipher.decrypt(a, "name".toByteArray()))
    }

    @Test
    fun `aad binds the ciphertext to its name`() {
        val a = cipher.encrypt("token".toByteArray(), "credentials".toByteArray())
        assertFailsWith<GeneralSecurityException> { cipher.decrypt(a, "templates".toByteArray()) }
    }

    @Test
    fun `blob store - atomic encrypted files, missing returns null`() {
        val dir = Files.createTempDirectory("blobs").toFile()
        try {
            val s = SecureBlobStore(dir, cipher)
            assertNull(s.read("credentials"))
            s.writeText("credentials", "{\"token\":\"secret-token\"}")
            assertEquals("{\"token\":\"secret-token\"}", s.readText("credentials"))
            assertFalse(String(dir.resolve("credentials.bin").readBytes(), Charsets.ISO_8859_1).contains("secret-token"))
            s.writeText("credentials", "v2")
            assertEquals("v2", s.readText("credentials"))
            assertEquals(listOf("credentials"), s.names())
            s.delete("credentials")
            assertNull(s.read("credentials"))
            assertFailsWith<IllegalArgumentException> { s.write("../x", byteArrayOf()) }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `sha256 and hex normalisation`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Hashing.sha256Hex(ByteArray(0)))
        assertEquals("abcd01", Hashing.normalizeHex("AB:CD:01"))
        assertNotEquals(Hashing.normalizeHex("ab cd"), Hashing.normalizeHex("abce"))
    }
}
