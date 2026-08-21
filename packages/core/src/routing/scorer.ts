/**
 * Routing-Scorer (`01-plan.md` §6.2): sechs gewichtete Achsen.
 *
 * Die Basis-Formeln (contextFit, capabilityMatch, costScore) kommen aus
 * `@diriz/shared/scoring` — damit Core & UI exakt dieselbe Formel kennen.
 * Output: `CandidateScore` (0–100, Achsen-Breakdown) für die Explainability.
 */

import {
	type CandidateScore,
	capabilityMatchScore,
	contextFitScore,
	costScore,
	type InstanceModel,
	type ScoringWeights,
	type TaskProfile,
} from "@diriz/shared"
import type { Feedback } from "./feedback.js"

/** Kontext zum Kandidaten, den der Core kennt (Status, Latenz, Load). */
export interface CandidateInfo {
	instance: InstanceModel
	/** 0 = frei, 1 = maximal belegt (z. B. VRAM via Ollama `/api/ps`). */
	loadFactor: number
	providerLatencyMs?: number
	basisPrior: number
}

const AXIS_LABELS: Record<keyof ScoringWeights, string> = {
	contextFit: "Context-Fit",
	capabilityMatch: "Capability-Match",
	qualityPrior: "Qualität",
	loadScore: "Last",
	costScore: "Kosten",
	latencyScore: "Latenz",
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

function loadScoreValue(loadFactor: number): number {
	return Math.max(0, 1 - Math.min(1, loadFactor))
}

function latencyScoreValue(latencyMs: number | undefined): number {
	if (latencyMs === undefined) {
		return 0.7 // unbekannt → neutral
	}
	// 0 ms → 1.0, ≥ 2000 ms → 0.3
	return Math.max(0.3, Math.min(1, 1 - latencyMs / 2000))
}

/**
 * Bewertet einen Kandidaten über alle sechs Achsen.
 * Harte Gates (Pflicht-Capabilities, Context-Gate, Privatsphäre) laufen
 * vorher als Policies — hier wird nur gescord.
 */
export function scoreCandidate(
	info: CandidateInfo,
	profile: TaskProfile,
	weights: ScoringWeights,
	feedback: Feedback,
): CandidateScore {
	const values: Record<keyof ScoringWeights, number> = {
		contextFit: contextFitScore(info.instance.contextWindow, profile.estTokens),
		capabilityMatch: capabilityMatchScore(
			profile.requiredCapabilities,
			profile.preferredCapabilities,
			info.instance.capabilities,
		),
		qualityPrior: feedback.prior(info.instance.id, info.basisPrior),
		loadScore: loadScoreValue(info.loadFactor),
		costScore: costScore(info.instance.pricePerMTok, profile.budgetUsd),
		latencyScore: latencyScoreValue(info.providerLatencyMs),
	}

	const axes = (Object.keys(values) as (keyof ScoringWeights)[]).map((key) => ({
		key,
		label: AXIS_LABELS[key],
		value: round3(values[key]),
		weight: weights[key],
		weighted: round3(values[key] * weights[key]),
	}))

	return {
		instanceId: info.instance.id,
		providerId: info.instance.providerId,
		modelId: info.instance.modelId,
		score: round3(axes.reduce((sum, a) => sum + a.weighted, 0) * 100),
		axes,
	}
}
