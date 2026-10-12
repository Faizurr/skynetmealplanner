package com.attendance.kiosk.core.face

import com.attendance.kiosk.core.api.TemplatesResponse

/** Decoded templates of one employee. */
class TemplateSet(
    val employeeId: String,
    val displayName: String,
    val fullName: String,
    val staffId: String,
    val vectors: List<FloatArray>,
)

enum class MatchReason { NO_TEMPLATES, BELOW_THRESHOLD, AMBIGUOUS }

data class MatchResult(
    val employeeId: String?,
    val score: Double,
    val secondEmployeeId: String?,
    val secondScore: Double,
    val accepted: Boolean,
    val reason: MatchReason?,
)

/**
 * 1:N identification — a line-for-line port of `identify()` in server/src/face.ts so the
 * kiosk and the server reach the same decision. Per-employee score = best cosine across that
 * employee's templates. Accept only if best >= threshold AND best − second-best employee >= margin.
 * Never guesses.
 */
object Matcher {
    fun identify(probe: FloatArray, sets: List<TemplateSet>, threshold: Double, margin: Double): MatchResult {
        var bestId: String? = null
        var bestS = -1.0
        var secondId: String? = null
        var secondS = -1.0
        for (set in sets) {
            var s = -1.0
            for (v in set.vectors) s = maxOf(s, EmbeddingCodec.cosine(probe, v))
            if (s > bestS) {
                secondId = bestId
                secondS = bestS
                bestId = set.employeeId
                bestS = s
            } else if (s > secondS) {
                secondId = set.employeeId
                secondS = s
            }
        }
        val base = MatchResult(bestId, bestS, secondId, secondS, accepted = false, reason = null)
        if (bestId == null) return base.copy(reason = MatchReason.NO_TEMPLATES)
        if (bestS < threshold) return base.copy(reason = MatchReason.BELOW_THRESHOLD)
        if (secondId != null && bestS - secondS < margin) return base.copy(reason = MatchReason.AMBIGUOUS)
        return base.copy(accepted = true)
    }

    /** Decodes a templates payload; malformed vectors are skipped rather than crashing the kiosk. */
    fun decodeTemplates(resp: TemplatesResponse): List<TemplateSet> = resp.employees.mapNotNull { e ->
        val vectors = e.templates.mapNotNull { runCatching { EmbeddingCodec.decode(it) }.getOrNull() }
        if (vectors.isEmpty()) null else TemplateSet(e.id, e.displayName, e.fullName, e.staffId, vectors)
    }
}
