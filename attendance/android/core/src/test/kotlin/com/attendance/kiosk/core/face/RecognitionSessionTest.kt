package com.attendance.kiosk.core.face

import com.attendance.kiosk.core.Vectors
import com.attendance.kiosk.core.face
import com.attendance.kiosk.core.liveness.HeadTurnChallenge
import com.attendance.kiosk.core.liveness.LivenessFailure
import com.attendance.kiosk.core.liveness.LivenessPrompt
import com.attendance.kiosk.core.liveness.TurnDirection
import com.attendance.kiosk.core.templateSet
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

class RecognitionSessionTest {
    private val rng = Random(2024)
    private val sarah = Vectors.random(rng)
    private val ben = Vectors.random(rng)
    private val templates = listOf(templateSet("sarah", "Sarah Lim", sarah), templateSet("ben", "Ben Tan", ben))
    private var t = 0L

    private fun session(liveness: Boolean = false, cfg: RecognitionConfig = RecognitionConfig()) =
        RecognitionSession(templates, 0.5, 0.06, if (liveness) HeadTurnChallenge(TurnDirection.LEFT) else null, cfg)

    /** How a person looks in front of the kiosk today: [similarity] to their enrolled template. */
    private fun look(person: FloatArray, similarity: Double = 0.9) = Vectors.withSimilarity(person, similarity, rng)

    private val sarahNow = look(sarah)
    private val benNow = look(ben)

    /** One camera frame of [appearance]; consecutive frames are similar (~0.94) but not duplicates. */
    private fun frame(s: RecognitionSession, appearance: FloatArray, yaw: Float = 0f, x: Float = 200f): RecognitionUpdate {
        t += 125
        val f = face(x = x + (t / 125 % 4), yaw = yaw)
        val step = s.onDetections(listOf(f), t)
        val need = assertIs<DetectionStep.NeedEmbedding>(step)
        return s.onEmbedding(need.face, Vectors.withSimilarity(appearance, 0.97, rng), t)
    }

    @Test
    fun `requires three consecutive agreeing frames`() {
        val s = session()
        assertIs<RecognitionUpdate.Progress>(frame(s, sarahNow)).also { assertEquals(1, it.agreeingFrames) }
        assertIs<RecognitionUpdate.Progress>(frame(s, sarahNow)).also { assertEquals(2, it.agreeingFrames) }
        val acc = assertIs<RecognitionUpdate.Accepted>(frame(s, sarahNow))
        assertEquals("sarah", acc.candidate.employeeId)
        assertEquals("Sarah", acc.candidate.displayName)
        assertTrue(acc.candidate.score >= 0.5)
        assertEquals(false, acc.candidate.livenessPassed)
    }

    @Test
    fun `a different person resets the streak`() {
        val s = session()
        frame(s, sarahNow); frame(s, sarahNow)
        assertIs<RecognitionUpdate.Progress>(frame(s, benNow)).also {
            assertEquals(Guidance.FACE_CHANGED, it.guidance)
            assertEquals(0, it.agreeingFrames)
        }
        assertIs<RecognitionUpdate.Progress>(frame(s, benNow)).also { assertEquals(1, it.agreeingFrames) }
        frame(s, benNow)
        assertEquals("ben", assertIs<RecognitionUpdate.Accepted>(frame(s, benNow)).candidate.employeeId)
    }

    @Test
    fun `an ambiguous frame in the middle breaks consecutiveness`() {
        // Threshold 0.5, margin 0.06; the middle frame matches Sarah and Ben equally.
        val s = session()
        frame(s, sarahNow); frame(s, sarahNow)
        t += 125
        val f = face(x = 203f)
        s.onDetections(listOf(f), t)
        val mid = EmbeddingCodec.normalize(FloatArray(128) { sarah[it] + ben[it] + sarahNow[it] * 0.0f })
        assertIs<RecognitionUpdate.Progress>(s.onEmbedding(f, mid, t)).also { assertEquals(0, it.agreeingFrames) }
    }

    @Test
    fun `low confidence frames never produce an acceptance (never guess)`() {
        val s = session()
        val unknownNow = look(sarah, 0.42)
        repeat(23) { assertIs<RecognitionUpdate.Progress>(frame(s, unknownNow)) }
        val u = assertIs<RecognitionUpdate.Unknown>(frame(s, unknownNow))
        assertTrue(u.bestScore!! < 0.5)
    }

    @Test
    fun `multiple faces block and reset the streak`() {
        val s = session()
        frame(s, sarahNow); frame(s, sarahNow)
        t += 125
        val step = s.onDetections(listOf(face(x = 50f), face(x = 400f)), t)
        val done = assertIs<DetectionStep.Done>(step)
        assertEquals(Guidance.ONE_PERSON_ONLY, assertIs<RecognitionUpdate.Progress>(done.update).guidance)
        assertIs<RecognitionUpdate.Progress>(frame(s, sarahNow)).also { assertEquals(1, it.agreeingFrames) }
    }

    @Test
    fun `small faces ask to come closer and are not matched`() {
        val s = session()
        val done = assertIs<DetectionStep.Done>(s.onDetections(listOf(face(size = 79f)), 1))
        assertEquals(Guidance.COME_CLOSER, assertIs<RecognitionUpdate.Progress>(done.update).guidance)
        assertEquals(0, s.matchedFrames)
    }

    @Test
    fun `no face keeps guiding`() {
        val s = session()
        val done = assertIs<DetectionStep.Done>(s.onDetections(emptyList(), 1))
        assertEquals(Guidance.POSITION_FACE, assertIs<RecognitionUpdate.Progress>(done.update).guidance)
    }

    @Test
    fun `low detector scores are ignored`() {
        val s = session()
        val done = assertIs<DetectionStep.Done>(s.onDetections(listOf(face(score = 0.5f)), 1))
        assertEquals(Guidance.POSITION_FACE, assertIs<RecognitionUpdate.Progress>(done.update).guidance)
    }

    @Test
    fun `near-identical consecutive frames are skipped as duplicates`() {
        val s = session()
        val e = Vectors.withSimilarity(sarah, 0.9, rng)
        repeat(5) { i ->
            val f = face()
            assertIs<DetectionStep.NeedEmbedding>(s.onDetections(listOf(f), i * 125L))
            val u = s.onEmbedding(f, e.copyOf(), i * 125L)
            assertIs<RecognitionUpdate.Progress>(u, "duplicate frames must not reach consensus")
        }
        assertEquals(1, s.matchedFrames)
    }

    @Test
    fun `accepts at most once - terminal afterwards`() {
        val s = session()
        frame(s, sarahNow); frame(s, sarahNow)
        val first = assertIs<RecognitionUpdate.Accepted>(frame(s, sarahNow))
        val again = s.onEmbedding(face(), Vectors.withSimilarity(ben, 0.9, rng), t + 1)
        assertEquals(first, again)
        assertTrue(s.isFinished)
        assertIs<DetectionStep.Done>(s.onDetections(listOf(face()), t + 2))
    }

    @Test
    fun `face change without liveness restarts consensus`() {
        val s = session()
        frame(s, sarahNow); frame(s, sarahNow)
        val u = assertIs<RecognitionUpdate.Progress>(frame(s, benNow))
        assertEquals(Guidance.FACE_CHANGED, u.guidance)
        frame(s, benNow); frame(s, benNow)
        assertEquals("ben", assertIs<RecognitionUpdate.Accepted>(frame(s, benNow)).candidate.employeeId)
    }

    @Test
    fun `with liveness required, consensus alone is not enough`() {
        val s = session(liveness = true)
        repeat(6) {
            val u = assertIs<RecognitionUpdate.Progress>(frame(s, sarahNow))
            assertEquals(LivenessPrompt.TURN_LEFT, u.livenessPrompt)
        }
        // Turn left: turned frames are ignored for matching.
        assertEquals(LivenessPrompt.LOOK_STRAIGHT, assertIs<RecognitionUpdate.Progress>(frame(s, sarahNow, yaw = 0.25f)).livenessPrompt)
        // Back to centre: challenge passes and the existing streak is accepted.
        val acc = assertIs<RecognitionUpdate.Accepted>(frame(s, sarahNow, yaw = 0.0f))
        assertEquals(true, acc.candidate.livenessPassed)
        assertEquals("sarah", acc.candidate.employeeId)
    }

    @Test
    fun `liveness face swap fails the attempt`() {
        val s = session(liveness = true)
        frame(s, sarahNow); frame(s, sarahNow, yaw = 0.25f)
        val u = assertIs<RecognitionUpdate.LivenessFailed>(frame(s, benNow))
        assertEquals(LivenessFailure.FACE_SWAPPED, u.reason)
    }

    @Test
    fun `liveness timeout fails the attempt even though the face matches`() {
        val s = session(liveness = true)
        var last: RecognitionUpdate? = null
        for (i in 0 until 80) { // up to 10 s of frontal frames, never turning
            last = frame(s, sarahNow)
            if (last !is RecognitionUpdate.Progress) break
        }
        assertEquals(LivenessFailure.TIMEOUT, assertIs<RecognitionUpdate.LivenessFailed>(last).reason)
        assertTrue(t >= 8_000)
    }

    @Test
    fun `liveness timeout is also enforced by tick when no usable face arrives`() {
        val s = session(liveness = true)
        frame(s, sarahNow)
        assertNull(s.tick(t + 1_000))
        assertIs<RecognitionUpdate.LivenessFailed>(s.tick(t + 9_000))
    }

    @Test
    fun `attempt timeout - unknown face when faces were matched, otherwise no face`() {
        val withFaces = session()
        val stranger = look(sarah, 0.3)
        frame(withFaces, stranger); frame(withFaces, stranger); frame(withFaces, stranger)
        assertIs<RecognitionUpdate.Unknown>(withFaces.onAttemptTimeout())

        val empty = session()
        empty.onDetections(emptyList(), 1)
        assertEquals(RecognitionUpdate.NoFaceTimeout, empty.onAttemptTimeout())
    }

    @Test
    fun `ambiguous look-alikes are never accepted`() {
        val a = Vectors.random(rng)
        val b = Vectors.withSimilarity(a, 0.97, rng)
        val s = RecognitionSession(listOf(templateSet("a", "A", a), templateSet("b", "B", b)), 0.5, 0.06, null)
        repeat(30) {
            t += 125
            val f = face(x = 200f + it % 3)
            s.onDetections(listOf(f), t)
            val u = s.onEmbedding(f, Vectors.withSimilarity(a, 0.9, rng), t)
            if (u is RecognitionUpdate.Accepted) fail("ambiguous match accepted")
        }
        assertNull(null)
    }
}
