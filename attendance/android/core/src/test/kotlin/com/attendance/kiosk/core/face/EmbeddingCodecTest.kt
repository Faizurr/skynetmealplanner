package com.attendance.kiosk.core.face

import com.attendance.kiosk.core.Vectors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.float
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.abs
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class EmbeddingCodecTest {
    private val fixture by lazy {
        Json.parseToJsonElement(javaClass.getResource("/server-parity.json")!!.readText()).jsonObject
    }

    @Test
    fun `encoding matches the server's encodeEmbedding byte for byte`() {
        val codec = fixture["codec"]!!.jsonObject
        val values = codec["values"]!!.jsonArray.map { it.jsonPrimitive.float }.toFloatArray()
        assertEquals(codec["encoded"]!!.jsonPrimitive.content, EmbeddingCodec.encode(values))
    }

    @Test
    fun `decoding normalises exactly like the server's decodeEmbedding`() {
        val codec = fixture["codec"]!!.jsonObject
        val expected = codec["decoded_normalized"]!!.jsonArray.map { it.jsonPrimitive.double }
        val decoded = EmbeddingCodec.decode(codec["encoded"]!!.jsonPrimitive.content)
        expected.forEachIndexed { i, e -> assertTrue(abs(decoded[i] - e) < 1e-6, "index $i: ${decoded[i]} vs $e") }
    }

    @Test
    fun `format is 128 little-endian float32 in standard base64`() {
        val v = FloatArray(128) { if (it == 0) 1f else 0f }
        val bytes = Base64.getDecoder().decode(EmbeddingCodec.encode(v))
        assertEquals(512, bytes.size)
        assertEquals(1f, ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getFloat(0))
        // 1.0f little-endian = 00 00 80 3F
        assertContentEquals(byteArrayOf(0, 0, 0x80.toByte(), 0x3F), bytes.copyOfRange(0, 4))
    }

    @Test
    fun `round trip preserves a normalised vector`() {
        val v = Vectors.random(Random(1))
        val back = EmbeddingCodec.decode(EmbeddingCodec.encode(v))
        v.indices.forEach { assertTrue(abs(v[it] - back[it]) < 1e-6) }
        assertTrue(abs(EmbeddingCodec.cosine(back, back) - 1.0) < 1e-5)
    }

    @Test
    fun `decode rejects wrong sizes, garbage and non-finite values`() {
        assertFailsWith<IllegalArgumentException> { EmbeddingCodec.decode(Base64.getEncoder().encodeToString(ByteArray(508))) }
        assertFailsWith<IllegalArgumentException> { EmbeddingCodec.decode("not base64 !!!") }
        val nan = ByteBuffer.allocate(512).order(ByteOrder.LITTLE_ENDIAN).apply { putFloat(0, Float.NaN) }.array()
        assertFailsWith<IllegalArgumentException> { EmbeddingCodec.decode(Base64.getEncoder().encodeToString(nan)) }
        assertFailsWith<IllegalArgumentException> { EmbeddingCodec.decode(Base64.getEncoder().encodeToString(ByteArray(512))) }
    }

    @Test
    fun `encode rejects wrong dimension`() {
        assertFailsWith<IllegalArgumentException> { EmbeddingCodec.encode(FloatArray(127)) }
    }
}
