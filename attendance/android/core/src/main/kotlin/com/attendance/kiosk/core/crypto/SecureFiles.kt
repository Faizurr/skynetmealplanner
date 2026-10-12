package com.attendance.kiosk.core.crypto

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.GeneralSecurityException

object AtomicFiles {
    /** Writes [bytes] to a temp file in the same directory, fsyncs, then renames over [target]. */
    fun write(target: File, bytes: ByteArray) {
        val dir = target.parentFile ?: throw IOException("no parent directory for $target")
        if (!dir.exists() && !dir.mkdirs() && !dir.exists()) throw IOException("cannot create $dir")
        val tmp = File(dir, ".${target.name}.${System.nanoTime()}.tmp")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.flush()
                out.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}

/**
 * Small encrypted key→blob store (one file per name, atomic writes). Used for the device
 * credentials, cached templates, the offline queue and local state.
 */
class SecureBlobStore(private val dir: File, private val cipher: ByteCipher) {
    private val validName = Regex("^[A-Za-z0-9._-]{1,100}$")

    private fun file(name: String): File {
        require(validName.matches(name) && !name.startsWith(".")) { "invalid blob name" }
        return File(dir, "$name.bin")
    }

    @Synchronized
    fun write(name: String, plain: ByteArray) {
        AtomicFiles.write(file(name), cipher.encrypt(plain, name.toByteArray(Charsets.UTF_8)))
    }

    /** Returns null when missing or undecryptable (e.g. the Keystore key was reset). */
    @Synchronized
    fun read(name: String): ByteArray? {
        val f = file(name)
        if (!f.exists()) return null
        return try {
            cipher.decrypt(f.readBytes(), name.toByteArray(Charsets.UTF_8))
        } catch (e: GeneralSecurityException) {
            null
        } catch (e: IOException) {
            null
        }
    }

    @Synchronized
    fun delete(name: String): Boolean = file(name).let { !it.exists() || it.delete() }

    @Synchronized
    fun names(): List<String> = (dir.listFiles() ?: emptyArray())
        .filter { it.isFile && it.name.endsWith(".bin") && !it.name.startsWith(".") }
        .map { it.name.removeSuffix(".bin") }
        .sorted()

    fun readText(name: String): String? = read(name)?.toString(Charsets.UTF_8)
    fun writeText(name: String, text: String) = write(name, text.toByteArray(Charsets.UTF_8))
}
