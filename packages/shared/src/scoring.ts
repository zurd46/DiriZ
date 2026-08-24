/**
 * Scoring-Regeln (`01-plan.md` §6.2) — rein und deterministisch.
 *
 * Lebt in `shared`, weil Core (Ausführung) und Web (Explainability-Panel)
 * dieselbe Formel kennen müssen: Die UI zeigt exakt die Achsen an, die der
 * Core berechnet hat — keine Drift möglich.
 */

import { SAFETY_CONTEXT_FACTOR } from "./constants.js"
import type { ScoringWeights } from "./routing.js"
import type { Capability } from "./types.js"

/**
 * Default-Gewichte aus dem Plan (§6.2):
 *
 * ```
 * score = 0.23 · contextFit
 *       + 0.23 · capabilityMatch
 *       + 0.16 · qualityPrior
 *       + 0.12 · specFit
 *       + 0.10 · providerSpread
 *       + 0.07 · loadScore
 *       + 0.05 · costScore
 *       + 0.04 · latencyScore
 * ```
 *
 * `specFit` kam mit dem `llm.md` dazu: Stärken und Schwächen, die im
 * Datenblatt eines Modells stehen, sollen die Auswahl auch tatsächlich
 * bewegen. Das Gewicht stammt aus `contextFit`/`capabilityMatch`/`qualityPrior`
 * — die Summe bleibt 1.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
	contextFit: 0.23,
	capabilityMatch: 0.23,
	qualityPrior: 0.16,
	specFit: 0.12,
	providerSpread: 0.1,
	loadScore: 0.07,
	costScore: 0.05,
	latencyScore: 0.04,
	hostLoad: 0, // M8: aus — Host-RAM-Last wird erst aktiv, wenn der Nutzer sie gewichtet
}

/** Cost-Aware-Modus: cost-Gewicht ×3, Rest wird renormiert (§6.3). */
export function costAwareWeights(base: ScoringWeights = DEFAULT_WEIGHTS): ScoringWeights {
	const cost = base.costScore * 3
	const rest = 1 - cost
	const scale = (v: number) => (v / (1 - base.costScore)) * rest
	return {
		contextFit: scale(base.contextFit),
		capabilityMatch: scale(base.capabilityMatch),
		qualityPrior: scale(base.qualityPrior),
		specFit: scale(base.specFit ?? 0),
		providerSpread: scale(base.providerSpread ?? 0),
		loadScore: scale(base.loadScore),
		costScore: cost,
		latencyScore: scale(base.latencyScore),
		hostLoad: base.hostLoad === undefined ? 0 : scale(base.hostLoad),
	}
}

/** Summiert die Gewichte und renormiert auf 1 (für benutzerdefinierte Gewichte). */
export function normalizeWeights(weights: ScoringWeights): ScoringWeights {
	const hostLoad = weights.hostLoad ?? 0
	const specFit = weights.specFit ?? 0
	const spread = weights.providerSpread ?? 0
	const sum =
		weights.contextFit +
		weights.capabilityMatch +
		weights.qualityPrior +
		weights.loadScore +
		weights.costScore +
		weights.latencyScore +
		specFit +
		spread +
		hostLoad
	if (sum <= 0) {
		return { ...DEFAULT_WEIGHTS }
	}
	return {
		contextFit: weights.contextFit / sum,
		capabilityMatch: weights.capabilityMatch / sum,
		qualityPrior: weights.qualityPrior / sum,
		specFit: specFit / sum,
		providerSpread: spread / sum,
		loadScore: weights.loadScore / sum,
		costScore: weights.costScore / sum,
		latencyScore: weights.latencyScore / sum,
		hostLoad: hostLoad / sum,
	}
}

/**
 * Context-Fit: 1.0, wenn das Window ≥ 1.3·estTokens; darunter linearer Decay
 * bis 0 bei 0.5·estTokens (unterhalb bricht selbst ein leiser Output weg).
 */
export function contextFitScore(contextWindow: number, estTokens: number): number {
	if (estTokens <= 0) {
		return 1
	}
	const comfortable = contextWindow / estTokens
	if (comfortable >= SAFETY_CONTEXT_FACTOR) {
		return 1
	}
	if (comfortable <= 0.5) {
		return 0
	}
	return (comfortable - 0.5) / (SAFETY_CONTEXT_FACTOR - 0.5)
}

/**
 * Capability-Match: Pflicht-Capabilities sind harte Gates (außerhalb der
 * Funktion), hier gibt es den Bonus: 0.6 für Pflicht-Erfüllung, +0.05 pro
 * zusätzlichem Wunsch-Feature, max. 1.0.
 */
export function capabilityMatchScore(
	required: Capability[],
	preferred: Capability[],
	modelCaps: Capability[],
): number {
	const has = (cap: Capability) => modelCaps.includes(cap)
	const requiredOk = required.every(has)
	if (!requiredOk) {
		return 0
	}
	const preferredHits = preferred.filter(has).length
	return Math.min(1, 0.6 + 0.05 * preferredHits)
}

/**
 * Freier Rechner: 1.0, wenn dort gerade nichts läuft, danach fallend
 * (1 Auftrag → 0.5, 2 → 0.33). Damit wandert der nächste Auftrag von selbst
 * auf die unbeschäftigte Maschine, statt sich auf der schnellsten zu stapeln.
 *
 * Bewusst kein hartes Gate: Ist der zweite Rechner deutlich schlechter
 * bestückt, darf der bessere trotzdem gewinnen — die Achse verschiebt, sie
 * verbietet nicht.
 */
export function providerSpreadScore(activeCount: number | undefined): number {
	const active = Math.max(0, activeCount ?? 0)
	return 1 / (1 + active)
}

/** Lokale Instanz = kostenlos; Cloud = f(Preis, Budget), 0.3–1.0. */
export function costScore(pricePerMTok: { in: number; out: number } | undefined, budgetUsd?: number): number {
	if (!pricePerMTok) {
		return 1
	}
	const perMtok = (pricePerMTok.in + pricePerMTok.out) / 2
	// 1 $/MTok gilt als günstig, 20 $/MTok als teuer → 0.3.
	const priceFit = Math.max(0.3, 1 - ((perMtok - 1) / 19) * 0.7)
	if (budgetUsd !== undefined && budgetUsd <= 0) {
		return 0.3
	}
	return priceFit
}

/**
 * Konservative Token-Schätzung: ~3.5 Zeichen pro Token (Mix aus
 * europäischen Sprachen + Code) + Reserve für den Output.
 */
export function estimateTokens(prompt: string, expectedOutputTokens = 1024): number {
	return Math.ceil(prompt.length / 3.5) + expectedOutputTokens
}
