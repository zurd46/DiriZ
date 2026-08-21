/**
 * Qualitäts-Prior (`01-plan.md` §6.2 Achse 3):
 * 0.5·Basisprior + 0.3·Ø-Bewertung + 0.2·Erfolgsquote.
 *
 * Ratings (1–5) werden exponentiell glattgewichtet (EMA, λ=0.9), damit
 * frisches Feedback stärker zählt. Ohne Daten → Basisprior (Default 0.6).
 */

const LAMBDA = 0.9
const NEUTRAL = 0.5

interface FeedbackState {
	success: number
	failure: number
	ratingSum: number
}

export class Feedback {
	private state = new Map<string, FeedbackState>()

	record(instanceId: string, ok: boolean, rating?: number): void {
		const s = this.state.get(instanceId) ?? { success: 0, failure: 0, ratingSum: 0 }
		if (ok) {
			s.success += 1
		} else {
			s.failure += 1
		}
		if (rating !== undefined) {
			const normalized = (rating - 1) / 4 // 1..5 → 0..1
			s.ratingSum = s.ratingSum === 0 ? normalized : LAMBDA * s.ratingSum + (1 - LAMBDA) * normalized
		}
		this.state.set(instanceId, s)
	}

	prior(instanceId: string, basisPrior = 0.6): number {
		const s = this.state.get(instanceId)
		if (!s) {
			return basisPrior
		}
		const total = s.success + s.failure
		const successRate = total > 0 ? s.success / total : NEUTRAL
		const avgRating = s.ratingSum > 0 ? s.ratingSum : NEUTRAL
		return Math.max(0, Math.min(1, 0.5 * basisPrior + 0.3 * avgRating + 0.2 * successRate))
	}

	get size(): number {
		return this.state.size
	}
}
