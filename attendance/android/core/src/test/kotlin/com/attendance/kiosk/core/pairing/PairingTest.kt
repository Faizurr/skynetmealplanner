package com.attendance.kiosk.core.pairing

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class PairingTest {
    @Test
    fun `pairing code normalisation accepts lowercase, spaces and missing dashes`() {
        assertEquals("K7Q-4MX-29P", PairingCode.normalize("K7Q-4MX-29P"))
        assertEquals("K7Q-4MX-29P", PairingCode.normalize("k7q 4mx 29p"))
        assertEquals("K7Q-4MX-29P", PairingCode.normalize(" k7q4mx29p "))
        assertEquals("K7Q-4MX-29P", PairingCode.normalize("k7q–4mx–29p"))
        assertNull(PairingCode.normalize("K7Q-4MX"))
        assertNull(PairingCode.normalize("K7Q-4MX-29P-1"))
        assertNull(PairingCode.normalize(""))
    }

    @Test
    fun `https server urls are accepted and normalised`() {
        val v = assertIs<ServerUrlResult.Valid>(ServerUrlValidator.validate("https://attendance.example.com/", false))
        assertEquals("https://attendance.example.com/", v.url.toString())
        assertIs<ServerUrlResult.Valid>(ServerUrlValidator.validate("attendance.example.com", false)).also { assertEquals("https", it.url.scheme) }
        assertIs<ServerUrlResult.Valid>(ServerUrlValidator.validate("https://example.com/attendance", false))
    }

    @Test
    fun `http is refused in release builds`() {
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("http://10.0.2.2:8080", false))
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("http://attendance.example.com", false))
    }

    @Test
    fun `http is allowed in debug only for local development hosts`() {
        for (u in listOf("http://10.0.2.2:8080", "http://localhost:8080", "http://127.0.0.1:3000", "http://192.168.1.20:8080")) {
            assertIs<ServerUrlResult.Valid>(ServerUrlValidator.validate(u, true), u)
        }
        for (u in listOf("http://attendance.example.com", "http://10.0.0.5", "http://192.168.1.300", "http://192.169.1.2")) {
            assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate(u, true), u)
        }
    }

    @Test
    fun `garbage and query strings are rejected`() {
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("", false))
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("https://", false))
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("https://example.com/?x=1", false))
        assertIs<ServerUrlResult.Invalid>(ServerUrlValidator.validate("ftp://example.com", false))
    }
}
