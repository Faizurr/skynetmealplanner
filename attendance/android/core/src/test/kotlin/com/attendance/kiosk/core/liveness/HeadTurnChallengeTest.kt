package com.attendance.kiosk.core.liveness

import com.attendance.kiosk.core.Vectors
import com.attendance.kiosk.core.face
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class HeadTurnChallengeTest {
    private val rng = Random(7)
    private val person = Vectors.random(rng)
    private fun emb() = Vectors.withSimilarity(person, 0.95, rng)

    /** Runs a yaw sequence at 125 ms per frame, with natural box jitter. */
    private fun run(c: HeadTurnChallenge, yaws: List<Float>, start: Long = 0, stepMs: Long = 125, jitter: Boolean = true): LivenessState {
        var s: LivenessState = c.state
        yaws.forEachIndexed { i, y ->
            val dx = if (jitter) (i % 5).toFloat() * 1.5f else 0f
            s = c.onFrame(face(x = 200f + dx, yaw = y), emb(), start + i * stepMs)
        }
        return s
    }

    @Test
    fun `turn left then back to centre passes (unmirrored frames, left = positive yaw)`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        assertEquals(LivenessState.WaitingForFace, c.state)
        val s = run(c, listOf(0f, 0.02f, 0.1f, 0.2f, 0.25f, 0.12f, 0.05f))
        assertEquals(LivenessState.Passed, s)
    }

    @Test
    fun `turn right passes with negative yaw`() {
        val c = HeadTurnChallenge(TurnDirection.RIGHT)
        assertEquals(LivenessState.Passed, run(c, listOf(0f, -0.1f, -0.22f, -0.1f, 0.0f)))
    }

    @Test
    fun `mirrored frames invert the sign`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT, LivenessConfig(framesMirrored = true))
        assertEquals(LivenessState.Passed, run(c, listOf(0f, -0.25f, 0f)))
    }

    @Test
    fun `prompts follow the sequence`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        assertEquals(LivenessState.InProgress(LivenessPrompt.TURN_LEFT), run(c, listOf(0f, 0.05f)))
        assertEquals(LivenessState.InProgress(LivenessPrompt.LOOK_STRAIGHT), c.onFrame(face(x = 205f, yaw = 0.3f), emb(), 300))
    }

    @Test
    fun `turning the wrong way does not pass`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        val s = run(c, listOf(0f, -0.3f, -0.3f, 0f, -0.25f, 0f))
        assertEquals(LivenessState.InProgress(LivenessPrompt.TURN_LEFT), s)
    }

    @Test
    fun `turn must exceed 0_18 and return within 0_08`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        assertEquals(LivenessState.InProgress(LivenessPrompt.TURN_LEFT), run(c, listOf(0f, 0.17f, 0.17f)))
        assertEquals(LivenessState.InProgress(LivenessPrompt.LOOK_STRAIGHT), run(c, listOf(0.19f, 0.10f), start = 400))
        assertEquals(LivenessState.Passed, run(c, listOf(0.07f), start = 700))
    }

    @Test
    fun `must start from looking straight - an already turned face does not count`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        val s = run(c, listOf(0.3f, 0.3f, 0.3f))
        assertEquals(LivenessState.InProgress(LivenessPrompt.TURN_LEFT), s)
    }

    @Test
    fun `times out after 8 seconds`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        // The employee keeps looking straight and never turns.
        run(c, List(16) { 0.02f }, stepMs = 500) // frames at 0 … 7.5 s
        assertIs<LivenessState.InProgress>(c.onTick(7_900))
        assertEquals(LivenessState.Failed(LivenessFailure.TIMEOUT), c.onTick(8_100))
        // Terminal: completing the turn afterwards does not help.
        assertEquals(LivenessState.Failed(LivenessFailure.TIMEOUT), c.onFrame(face(yaw = 0f), emb(), 8_300))
    }

    @Test
    fun `a different face during the challenge fails it`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        run(c, listOf(0f, 0.25f))
        val stranger = Vectors.random(Random(99))
        assertEquals(LivenessState.Failed(LivenessFailure.FACE_SWAPPED), c.onFrame(face(yaw = 0f), stranger, 400))
    }

    @Test
    fun `perfectly static face box is rejected as a photo`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        val s = run(c, listOf(0f, 0.25f, 0f), jitter = false)
        assertEquals(LivenessState.Failed(LivenessFailure.STATIC_FACE), s)
    }

    @Test
    fun `losing the face for too long fails`() {
        val c = HeadTurnChallenge(TurnDirection.LEFT)
        run(c, listOf(0f, 0.25f))
        assertEquals(LivenessState.Failed(LivenessFailure.LOST_TRACKING), c.onTick(2_000))
    }

    @Test
    fun `clock does not start before a face is seen`() {
        val c = HeadTurnChallenge(TurnDirection.RIGHT)
        assertEquals(LivenessState.WaitingForFace, c.onTick(60_000))
        assertTrue(!c.isFinished)
    }
}
