package com.attendance.kiosk.core.enroll

import com.attendance.kiosk.core.Vectors
import com.attendance.kiosk.core.face
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EnrollmentCaptureTest {
    private val rng = Random(11)
    private val person = Vectors.random(rng)

    @Test
    fun `guides through five poses and completes`() {
        val c = EnrollmentCapture()
        assertEquals(EnrollPose.STRAIGHT, c.currentPose)
        EnrollPose.entries.forEach { pose ->
            assertEquals(pose, c.currentPose)
            assertIs<SampleCheck.Ok>(c.offer(face(), Vectors.withSimilarity(person, 0.9, rng), 120.0))
        }
        assertTrue(c.isComplete)
        assertNull(c.currentPose)
        assertEquals(5, c.encoded().size)
        assertTrue(c.consistencyOk(0.5))
    }

    @Test
    fun `detections must be a single face of at least 100 px`() {
        val c = EnrollmentCapture()
        assertEquals(SampleIssue.NO_FACE, assertIs<SampleCheck.Rejected>(c.checkDetections(emptyList())).issue)
        assertEquals(SampleIssue.MULTIPLE_FACES, assertIs<SampleCheck.Rejected>(c.checkDetections(listOf(face(), face(x = 500f)))).issue)
        assertEquals(SampleIssue.TOO_SMALL, assertIs<SampleCheck.Rejected>(c.checkDetections(listOf(face(size = 99f)))).issue)
        assertIs<SampleCheck.Ok>(c.checkDetections(listOf(face(size = 100f))))
    }

    @Test
    fun `blurry samples are rejected`() {
        val c = EnrollmentCapture()
        assertEquals(SampleIssue.BLURRY, assertIs<SampleCheck.Rejected>(c.offer(face(), person, 12.0)).issue)
        assertEquals(0, c.count)
    }

    @Test
    fun `a different person mid-capture is rejected`() {
        val c = EnrollmentCapture()
        c.offer(face(), Vectors.withSimilarity(person, 0.9, rng), 100.0)
        assertEquals(SampleIssue.DIFFERENT_PERSON, assertIs<SampleCheck.Rejected>(c.offer(face(), Vectors.random(rng), 100.0)).issue)
        assertEquals(1, c.count)
    }

    @Test
    fun `consistency mirrors the server inconsistent_samples rule`() {
        val c = EnrollmentCapture(SampleQualityConfig(minSimilarityToFirst = 0.0))
        val a = Vectors.withSimilarity(person, 0.95, rng)
        c.offer(face(), a, 100.0)
        c.offer(face(), Vectors.withSimilarity(a, 0.47, rng), 100.0)
        c.offer(face(), Vectors.withSimilarity(a, 0.9, rng), 100.0)
        assertTrue(c.minPairSimilarity() < 0.5)
        assertFalse(c.consistencyOk(0.55)) // needs ≥ 0.50
        assertTrue(c.consistencyOk(0.40) == (c.minPairSimilarity() >= 0.4))
        c.reset()
        assertEquals(0, c.count)
    }
}
