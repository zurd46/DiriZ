/**
 * Routing-Policies (`01-plan.md` §6.3): harte Gates vor dem Scoring.
 *
 * - Provider offline / Circuit offen → Ausschluss
 * - `local-only` → Cloud-Provider (OpenRouter, OpenAI) hart ausfiltern
 * - `pinned` → nur die gepinnte Instanz
 * - Context-Gate: `contextWindow < 1.2·estTokens` → Ausschluss
 * - Pflicht-Capabilities fehlen → Ausschluss
 * - Rechner ausgelastet bzw. führt schon ein anderes Modell aus → Ausschluss
 *   (GPU-Schutz; die Arbeit wandert auf einen anderen Rechner)
 *
 * Jeder Ausschluss wird mit Begründung persistiert (Explainability, §6.4).
 */

import {
	type ConcurrencySettings,
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
	/** Modelle, die dieser Rechner **gerade ausführt** (GPU-Schutz). */
	providerActiveModels?: string[]
}

export interface PolicyResult {
	weights: ScoringWeights
	excluded: ExcludedInstance[]
	allowed: PolicyCandidate[]
	/**
	 * Wurde **ausschliesslich** wegen Auslastung ausgeschlossen? Dann ist die
	 * Task nicht unmöglich, sondern zu früh: Sie wartet, statt zu scheitern.
	 */
	onlyBusy: boolean
	/** Wurde nur an fehlenden Pflicht-Fähigkeiten gescheitert? */
	onlyCapabilities: boolean
}

export function applyPolicies(
	candidates: PolicyCandidate[],
	profile: TaskProfile,
	baseWeights: ScoringWeights,
	limits?: ConcurrencySettings,
	/** Kennung → Anzeigename, damit Ausschlussgründe lesbar sind. */
	labelOf?: (providerId: string) => string | undefined,
): PolicyResult {
	const weights =
		profile.mode === "cost-aware"
			? normalizeWeights(costAwareWeights(baseWeights))
			: normalizeWeights(baseWeights)
	const excluded: ExcludedInstance[] = []
	const allowed: PolicyCandidate[] = []
	/** Art des Ausschlusses je Kandidat — Grundlage für „warten statt scheitern". */
	const kinds: ("busy" | "capabilities" | "hard")[] = []

	const pushExcluded = (
		c: PolicyCandidate,
		reason: string,
		kind: "busy" | "capabilities" | "hard" = "hard",
	) => {
		kinds.push(kind)
		excluded.push({
			instanceId: c.instance.id,
			providerId: c.instance.providerId,
			modelId: c.instance.modelId,
			reason,
		})
	}

	for (const c of candidates) {
		if (!c.instance.enabled) {
			pushExcluded(c, "Modell auf diesem Rechner deaktiviert")
			continue
		}
		if (!c.providerOnline) {
			pushExcluded(c, "Provider offline oder Circuit-Breaker offen")
			continue
		}
		// GPU-Schutz (harte Gates, vor allem Scoring): Ein überfahrener Rechner
		// antwortet nicht schlechter, sondern gar nicht — er lädt minutenlang
		// Modelle um oder stirbt am Speicher. Beide Gates schliessen nur diesen
		// einen Rechner aus; andere bleiben Kandidaten, die Arbeit verteilt sich.
		if (limits) {
			const active = c.providerActiveCount ?? 0
			if (active >= limits.perProvider) {
				pushExcluded(
					c,
					`Rechner ausgelastet: ${active} gleichzeitige Ausführungen (Grenze ${limits.perProvider})`,
					"busy",
				)
				continue
			}
			const running = c.providerActiveModels ?? []
			if (!running.includes(c.instance.modelId) && running.length >= limits.maxModelsPerProvider) {
				pushExcluded(
					c,
					`GPU-Schutz: Rechner führt bereits ${running.length} Modell(e) aus (${running.join(", ")}) — ein weiteres würde zusätzlichen Grafikspeicher belegen`,
					"busy",
				)
				continue
			}
		}
		if (profile.privacy === "local-only" && CLOUD_TYPES.includes(c.providerType)) {
			pushExcluded(c, "Privatsphäre: local-only schließt Cloud-Provider aus")
			continue
		}
		if (profile.mode === "pinned") {
			if (profile.pinnedProviderId && c.instance.providerId !== profile.pinnedProviderId) {
				// Der Name, nicht die Kennung: „Pinned auf Provider
				// c7e00965-8eea-…" zwingt zum Nachschlagen in der Datenbank, um
				// eine Meldung zu verstehen, die eine Antwort geben sollte.
				pushExcluded(
					c,
					`Pinned auf Rechner ${labelOf?.(profile.pinnedProviderId) ?? profile.pinnedProviderId}`,
				)
				continue
			}
			if (profile.pinnedModelId && c.instance.modelId !== profile.pinnedModelId) {
				pushExcluded(c, `Pinned auf Modell ${profile.pinnedModelId}`)
				continue
			}
		}
		// Budget-Gate (§16): geschätzte Kosten = estTokens × Ø-Preis. Lokale
		// Modelle (ohne Preis) sind kostenlos und passieren immer.
		if (profile.budgetUsd !== undefined && profile.budgetUsd > 0 && c.instance.pricePerMTok) {
			const perMtok = (c.instance.pricePerMTok.in + c.instance.pricePerMTok.out) / 2
			const estCostUsd = (profile.estTokens * perMtok) / 1_000_000
			if (estCostUsd > profile.budgetUsd) {
				pushExcluded(
					c,
					`Budget-Gate: geschätzte Kosten ${estCostUsd.toFixed(3)} $ übersteigen Budget ${profile.budgetUsd} $`,
				)
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
			pushExcluded(c, `Fehlende Pflicht-Fähigkeiten: ${missing.join(", ")}`, "capabilities")
			continue
		}
		allowed.push(c)
	}

	return {
		weights,
		excluded,
		allowed,
		onlyBusy: kinds.length > 0 && kinds.every((k) => k === "busy"),
		onlyCapabilities: kinds.length > 0 && kinds.every((k) => k === "capabilities" || k === "busy"),
	}
}
