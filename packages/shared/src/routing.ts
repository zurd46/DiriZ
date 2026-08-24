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

/**
 * Parallelitäts- und GPU-Grenzen (Einstellungen, `settings.concurrency`).
 *
 * Sie greifen als **harte Gates** im Routing, nicht als Score: Ein
 * überfahrener Rechner liefert keine schlechteren Antworten, sondern gar
 * keine — er lädt minutenlang Modelle nach oder stirbt am Speicher.
 */
export interface ConcurrencySettings {
	/** Gleichzeitige Ausführungen über alle Rechner. */
	global: number
	/** Gleichzeitige Ausführungen auf **einem** Rechner. */
	perProvider: number
	/**
	 * Wie viele **verschiedene** Modelle ein Rechner gleichzeitig ausführen
	 * darf. 1 = strikter GPU-Schutz (empfohlen für eine einzelne Grafikkarte).
	 */
	maxModelsPerProvider: number
}

/**
 * Zeitgrenzen einer Ausführung (Einstellungen, `settings.timeouts`).
 *
 * Sie sind kein Feintuning, sondern entscheiden über Erfolg oder Verlust: Ein
 * Agentik-Lauf, der ein Repository liest und analysiert, braucht auf einem
 * grossen lokalen Modell leicht eine halbe Stunde. Läuft er in den
 * Gesamt-Timeout, ist die gesamte Arbeit gescheitert.
 */
export interface TimeoutSettings {
	/** Frist bis zum **ersten** Lebenszeichen — deckt das Laden des Modells ab. */
	firstChunkMs: number
	/** Frist zwischen zwei Lebenszeichen; ein verstummter Stream ist ein Fehler. */
	chunkMs: number
	/** Gesamtdauer einer Ausführung. */
	totalMs: number
}

/**
 * Umgang mit Repository-Arbeit (Einstellungen, `settings.git`).
 *
 * Beides zielt **immer** auf den Arbeitsbranch der Task (`diriz/…`), nie auf
 * den Basis-Branch: Ein Modell soll `main` nicht anfassen können, auch nicht
 * versehentlich.
 */
export interface GitSettings {
	/** Nach einem erfolgreichen Lauf automatisch committen. */
	autoCommit: boolean
	/** Den Arbeitsbranch danach zu GitHub pushen. */
	autoPush: boolean
}
