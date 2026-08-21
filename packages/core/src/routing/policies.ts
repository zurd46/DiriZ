/**
 * Routing-Policies (`01-plan.md` §6.3): harte Gates vor dem Scoring.
 *
 * - Provider offline / Circuit offen → Ausschluss
 * - `local-only` → Cloud-Provider (OpenRouter, OpenAI) hart ausfiltern
 * - `pinned` → nur die gepinnte Instanz
 * - Context-Gate: `contextWindow < 1.2·estTokens` → Ausschluss
 * - Pflicht-Capabilities fehlen → Ausschluss
 *
 * Jeder Ausschluss wird mit Begründung persistiert (Explainability, §6.4).
 */

import {
	costAwareWeights,
	type ExcludedInstance,
	normalizeWeights,
	type ProviderType,
	type ScoringWeights,
	type TaskProfile,
} from "@diriz/shared"
import type { CandidateInfo } from "./scorer.js"

/** Cloud-Provider-Typen — bei `local-only` nie erlaubt. */
const CLOUD_TYPES: ProviderType[] = ["openrouter", "openai"]

export interface PolicyCandidate extends CandidateInfo {
	providerType: ProviderType
	providerOnline: boolean
}

export interface PolicyResult {
	weights: ScoringWeights
	excluded: ExcludedInstance[]
	allowed: PolicyCandidate[]
}

export function applyPolicies(
	candidates: PolicyCandidate[],
	profile: TaskProfile,
	baseWeights: ScoringWeights,
): PolicyResult {
	const weights =
		profile.mode === "cost-aware"
			? normalizeWeights(costAwareWeights(baseWeights))
			: normalizeWeights(baseWeights)
	const excluded: ExcludedInstance[] = []
	const allowed: PolicyCandidate[] = []

	const pushExcluded = (c: PolicyCandidate, reason: string) => {
		excluded.push({
			instanceId: c.instance.id,
			providerId: c.instance.providerId,
			modelId: c.instance.modelId,
			reason,
		})
	}

	for (const c of candidates) {
		if (!c.providerOnline) {
			pushExcluded(c, "Provider offline oder Circuit-Breaker offen")
			continue
		}
		if (profile.privacy === "local-only" && CLOUD_TYPES.includes(c.providerType)) {
			pushExcluded(c, "Privatsphäre: local-only schließt Cloud-Provider aus")
			continue
		}
		if (profile.mode === "pinned") {
			if (profile.pinnedProviderId && c.instance.providerId !== profile.pinnedProviderId) {
				pushExcluded(c, `Pinned auf Provider ${profile.pinnedProviderId}`)
				continue
			}
			if (profile.pinnedModelId && c.instance.modelId !== profile.pinnedModelId) {
				pushExcluded(c, `Pinned auf Modell ${profile.pinnedModelId}`)
				continue
			}
		}
		if (c.instance.contextWindow < profile.estTokens * 1.2) {
			pushExcluded(
				c,
				`Context-Fenster zu klein: ${c.instance.contextWindow} < ${Math.ceil(profile.estTokens * 1.2)} Tokens`,
			)
			continue
		}
		const missing = profile.requiredCapabilities.filter((cap) => !c.instance.capabilities.includes(cap))
		if (missing.length > 0) {
			pushExcluded(c, `Fehlende Pflicht-Fähigkeiten: ${missing.join(", ")}`)
			continue
		}
		allowed.push(c)
	}

	return { weights, excluded, allowed }
}
