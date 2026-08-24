/**
 * Routing-Scorer (`01-plan.md` §6.2): gewichtete Achsen.
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
	type ModelSpec,
	type ScoringWeights,
	specFitScore,
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
	/** M8: läuft die Instanz auf diesem Rechner? (hostLoad-Achse) */
	local?: boolean
	/** M8: aktuelle RAM-Belegung des Hosts in % (0–100). */
	hostRamUsagePct?: number
	/** Datenblatt (`llm.md`) des Modells — Stärken, Schwächen, Qualitätsklasse. */
	spec?: ModelSpec
}

const AXIS_LABELS: Record<keyof ScoringWeights, string> = {
	contextFit: "Context-Fit",
	capabilityMatch: "Capability-Match",
	qualityPrior: "Qualität",
	specFit: "Eignung",
	loadScore: "Last",
	costScore: "Kosten",
	latencyScore: "Latenz",
	hostLoad: "Host-Last",
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

function loadScoreValue(loadFactor: number): number {
	return Math.max(0, 1 - Math.min(1, loadFactor))
}

/** M8: Hohe Host-RAM-Last bestraft lokale Instanzen (Swap/OOM-Risiko); Cloud bleibt neutral. */
function hostLoadValue(local: boolean | undefined, ramUsagePct: number | undefined): number {
	if (!local || ramUsagePct === undefined) {
		return 1
	}
	return Math.max(0, 1 - Math.min(100, ramUsagePct) / 100)
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
	/** Der Prompt — nur die Eignungs-Achse liest ihn (Stärken/Schwächen). */
	prompt = "",
): CandidateScore {
	const values: Record<keyof ScoringWeights, number> = {
		contextFit: contextFitScore(info.instance.contextWindow, profile.estTokens),
		capabilityMatch: capabilityMatchScore(
			profile.requiredCapabilities,
			profile.preferredCapabilities,
			info.instance.capabilities,
		),
		qualityPrior: feedback.prior(info.instance.id, info.basisPrior),
		// Eignung laut `llm.md`: „Gut für" hebt, „Nicht geeignet für" senkt.
		specFit: specFitScore(info.spec, prompt).value,
		loadScore: loadScoreValue(info.loadFactor),
		costScore: costScore(info.instance.pricePerMTok, profile.budgetUsd),
		latencyScore: latencyScoreValue(info.providerLatencyMs),
		hostLoad: hostLoadValue(info.local, info.hostRamUsagePct),
	}

	const axes = (Object.keys(values) as (keyof ScoringWeights)[]).map((key) => {
		const weight = weights[key] ?? 0
		return {
			key,
			label: AXIS_LABELS[key],
			value: round3(values[key]),
			weight,
			weighted: round3(values[key] * weight),
		}
	})

	return {
		instanceId: info.instance.id,
		providerId: info.instance.providerId,
		modelId: info.instance.modelId,
		score: round3(axes.reduce((sum, a) => sum + a.weighted, 0) * 100),
		axes,
	}
}
