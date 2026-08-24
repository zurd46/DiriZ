/**
 * Qualitäts-Prior (`01-plan.md` §6.2 Achse 3):
 * 0.5·Basisprior + 0.3·Ø-Bewertung + 0.2·Erfolgsquote.
 *
 * Ratings (1–5) werden exponentiell glattgewichtet (EMA, λ=0.9), damit
 * frisches Feedback stärker zählt. Ohne Daten → Basisprior (Default 0.6).
 *
 * **Dauerhaft.** Der Zustand lag bis M11 nur im Speicher: Nach jedem Neustart
 * begann die Qualitäts-Achse wieder bei der Katalog-Klasse, und alles, was
 * DiriZ über seine Modelle gelernt hatte, war weg. Jetzt liegt er in der
 * Datenbank (`instance_feedback`) — im Speicher steht nur noch ein Abbild,
 * damit das Scoring keine Abfrage pro Kandidat braucht.
 */

import type { Db } from "../db/connection.js"

const LAMBDA = 0.9
const NEUTRAL = 0.5

interface FeedbackState {
	success: number
	failure: number
	ratingSum: number
}

export class Feedback {
	private state = new Map<string, FeedbackState>()

	/**
	 * Ohne Datenbank bleibt es beim reinen Speicher-Betrieb — Tests und
	 * Werkzeuge brauchen keine Persistenz, das Verhalten ist identisch.
	 */
	constructor(private readonly db?: Db) {
		this.load()
	}

	/** Gelerntes aus der Datenbank holen — einmal beim Start. */
	private load(): void {
		if (!this.db) {
			return
		}
		const rows = this.db
			.prepare("SELECT instance_id, success, failure, rating_ema FROM instance_feedback")
			.all() as { instance_id: string; success: number; failure: number; rating_ema: number }[]
		for (const r of rows) {
			this.state.set(r.instance_id, { success: r.success, failure: r.failure, ratingSum: r.rating_ema })
		}
	}

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
		this.persist(instanceId, s)
	}

	private persist(instanceId: string, s: FeedbackState): void {
		if (!this.db || !instanceId) {
			return
		}
		this.db
			.prepare(
				`INSERT INTO instance_feedback (instance_id, success, failure, rating_ema, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(instance_id) DO UPDATE SET
					success = excluded.success,
					failure = excluded.failure,
					rating_ema = excluded.rating_ema,
					updated_at = excluded.updated_at`,
			)
			.run(instanceId, s.success, s.failure, s.ratingSum, new Date().toISOString())
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
