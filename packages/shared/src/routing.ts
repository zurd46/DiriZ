/**
 * Task-Profil & Scoring-Kontrakte (`01-plan.md` §5.3, §6).
 */

import type { Capability, PrivacyMode, RoutingMode } from "./types.js"

/**
 * Das Ergebnis der Task-Analyse: Was braucht diese Aufgabe?
 * Aus diesem Profil werden harte Gates und Scoring abgeleitet.
 */
export interface TaskProfile {
	/** Konservative Token-Schätzung (Prompt + erwarteter Output). */
	estTokens: number
	/** Pflicht-Capabilities = harte Gates. */
	requiredCapabilities: Capability[]
	/** Bonus-Capabilities = Score-Bonus. */
	preferredCapabilities: Capability[]
	privacy: PrivacyMode
	budgetUsd?: number
	mode: RoutingMode
	pinnedProviderId?: string
	pinnedModelId?: string
}

/** Gewichte des Scorings — in den Einstellungen justierbar (§6.2). */
export interface ScoringWeights {
	contextFit: number
	capabilityMatch: number
	qualityPrior: number
	loadScore: number
	costScore: number
	latencyScore: number
	/** M8: Host-RAM-Last bestraft lokale Instanzen (0 = aus, Default). */
	hostLoad?: number
}
