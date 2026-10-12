package com.attendance.kiosk.core.face

import com.attendance.kiosk.core.Vectors
import com.attendance.kiosk.core.api.TemplateEmployee
import com.attendance.kiosk.core.api.TemplatesResponse
import com.attendance.kiosk.core.templateSet
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.abs
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MatcherTest {
    private val rng = Random(42)

    @Test
    fun `parity with server identify() on 240 generated cases`() {
        val root = Json.parseToJsonElement(javaClass.getResource("/server-parity.json")!!.readText()).jsonObject
        val cases = root["cases"]!!.jsonArray
        assertEquals(240, cases.size)
        val seen = mutableSetOf<String>()
        for ((i, c) in cases.withIndex()) {
            val o = c.jsonObject
            val sets = o["employees"]!!.jsonArray.map { e ->
                val eo = e.jsonObject
                val id = eo["id"]!!.jsonPrimitive.content
                TemplateSet(id, id, id, id, eo["templates"]!!.jsonArray.map { EmbeddingCodec.decode(it.jsonPrimitive.content) })
            }
            val probe = EmbeddingCodec.decode(o["probe"]!!.jsonPrimitive.content)
            val m = Matcher.identify(probe, sets, o["threshold"]!!.jsonPrimitive.double, o["margin"]!!.jsonPrimitive.double)
            val exp = o["expected"]!!.jsonObject
            val expId = exp["employee_id"].let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }
            val expReason = exp["reason"].let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(exp["accepted"]!!.jsonPrimitive.boolean, m.accepted, "case $i accepted")
            assertEquals(expId, m.employeeId, "case $i employee")
            assertEquals(expReason, m.reason?.name?.lowercase(), "case $i reason")
            assertTrue(abs(exp["score"]!!.jsonPrimitive.double - m.score) < 1e-6, "case $i score ${m.score}")
            seen += if (m.accepted) "accepted" else m.reason!!.name
        }
        // The fixture exercises every branch of the rule.
        assertEquals(setOf("accepted", "BELOW_THRESHOLD", "AMBIGUOUS", "NO_TEMPLATES"), seen)
    }

    @Test
    fun `accepts a clear match above threshold with sufficient margin`() {
        val a = Vectors.random(rng); val b = Vectors.random(rng)
        val probe = Vectors.withSimilarity(a, 0.8, rng)
        val m = Matcher.identify(probe, listOf(templateSet("a", "Sarah Lim", a), templateSet("b", "Ben Tan", b)), 0.5, 0.06)
        assertTrue(m.accepted)
        assertEquals("a", m.employeeId)
        assertNull(m.reason)
    }

    @Test
    fun `below threshold is never accepted (never guesses)`() {
        val a = Vectors.random(rng)
        val probe = Vectors.withSimilarity(a, 0.45, rng)
        val m = Matcher.identify(probe, listOf(templateSet("a", "Sarah Lim", a)), 0.5, 0.06)
        assertFalse(m.accepted)
        assertEquals(MatchReason.BELOW_THRESHOLD, m.reason)
        assertEquals("a", m.employeeId) // best candidate is reported but NOT accepted
    }

    @Test
    fun `two employees within the margin is ambiguous`() {
        val a = Vectors.random(rng)
        val b = Vectors.withSimilarity(a, 0.9, rng) // look-alikes
        val probe = Vectors.withSimilarity(a, 0.85, rng)
        val m = Matcher.identify(probe, listOf(templateSet("a", "A", a), templateSet("b", "B", b)), 0.5, 0.5)
        assertFalse(m.accepted)
        assertEquals(MatchReason.AMBIGUOUS, m.reason)
    }

    @Test
    fun `margin compares against other employees only, not the same employee's templates`() {
        val a1 = Vectors.random(rng)
        val a2 = Vectors.withSimilarity(a1, 0.95, rng)
        val probe = Vectors.withSimilarity(a1, 0.8, rng)
        val m = Matcher.identify(probe, listOf(templateSet("a", "A", a1, a2)), 0.5, 0.06)
        assertTrue(m.accepted)
        assertNull(m.secondEmployeeId)
    }

    @Test
    fun `per employee score is the best template`() {
        val a1 = Vectors.random(rng)
        val far = Vectors.random(rng)
        val probe = Vectors.withSimilarity(a1, 0.7, rng)
        val m = Matcher.identify(probe, listOf(templateSet("a", "A", far, a1)), 0.5, 0.06)
        assertTrue(abs(m.score - 0.7) < 1e-3)
    }

    @Test
    fun `no templates`() {
        val m = Matcher.identify(Vectors.random(rng), emptyList(), 0.5, 0.06)
        assertFalse(m.accepted)
        assertEquals(MatchReason.NO_TEMPLATES, m.reason)
    }

    @Test
    fun `decodeTemplates skips malformed vectors and empty employees`() {
        val good = EmbeddingCodec.encode(Vectors.random(rng))
        val sets = Matcher.decodeTemplates(
            TemplatesResponse(
                employees = listOf(
                    TemplateEmployee("1", "Sarah Lim", "Sarah", "S001", listOf(good, "garbage")),
                    TemplateEmployee("2", "Ben Tan", null, "S002", listOf("bad")),
                ),
            ),
        )
        assertEquals(1, sets.size)
        assertEquals(1, sets[0].vectors.size)
        assertEquals("Sarah", sets[0].displayName)
    }
}
