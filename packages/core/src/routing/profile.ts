/**
 * Task-Profil-Extraktion (`01-plan.md` §6.1): heuristisch aus Prompt +
 * Metadaten — deterministisch, ohne LLM-Aufruf, in `shared`-Form
 * (`estTokens`, `requiredCapabilities`, …).
 *
 * T1-3 Erweiterung: Berücksichtigt das opt-in Router-Modell für die Klassifizierung.
 */

import type { Capability, Task, TaskProfile } from "@diriz/shared"
import { estimateTokens } from "@diriz/shared"
import { analyzePrompt, isRouterEnabled as isRouterEnabledFn } from "./llmRouter.js"

 // Router-Klassifikations-Patterns (ähnlich wie in llmRouter.ts)
const CODE_PATTERNS: RegExp[] = [
	/```/,
	/\b(function |def |class |interface |const |import |SELECT |CREATE TABLE |async )\b/i,
	/\b(bug|error|exception|stacktrace|crash|compile|build fail|refactor|optimisier)\b/i,
	/\b\.(py|ts|tsx|js|jsx|java|go|rs|cpp|cs|sql|sh)\b/i,
	/\b(django|flask|react|node|vite|express|fastify|postgres|redis|kafka)\b/i,
]

const REASONING_PATTERNS: RegExp[] = [
	/\b(analyse|analyse|diagnose|debug|optimisier|optimis|trade-?off|vergleich|compare|architektur|architecture)\b/i,
	/\b(warum|why|root cause|ursache)\b/i,
]

const LONGFORM_PATTERNS: RegExp[] = [
	/\b(article|blog|essay|bericht|dokumentation|documentation|guide|tutorial|handbuch)\b/i,
	/\b(übersetze|translate|zusammenfasse|summarize|erläutere|erkläre ausführlich)\b/i,
]

const JSON_PATTERNS: RegExp[] = [/\b(json|schema|api|endpoint|rest|graphql|yaml|config|konfiguration)\b/i]

const TOOLS_PATTERNS: RegExp[] = [
	/\b(aufrufen|call the|execute|ausführen|web-?tool|mcp|function-?calling)\b/i,
]

/**
 * Extrahiert das Task-Profil. `requiredCapabilities` werden harte Gates
 * im Routing (exkludieren), `preferredCapabilities` geben nur einen Bonus.
 *
 * T1-3: Wenn Router-Modell opt-in aktiv ist, wird die Analyse des Prompts
 * durch `llmRouter.analyzePrompt` ergänzt.
 *
 * @param task Die Task mit Prompt und Metadaten
 * @param attachmentCount Anzahl der Bild-Anhänge
 * @returns TaskProfile mit klassifizierten Fähigkeiten
 */
export function extractProfile(task: Task, attachmentCount = 0): TaskProfile {
	const prompt = task.prompt || ""
	const required: Capability[] = []
	const preferred: Capability[] = []

	// T1-3 Router-Modell opt-in prüfen
	const routerEnabled = isRouterEnabledFn(task)

	if (routerEnabled) {
		// Router-Modell Analyse verwenden
		const routerResult = analyzePrompt(prompt)
		;(routerResult.capabilities as string[]).forEach((cap) => {
			const capStr = cap as keyof Capability
			if (!required.includes(capStr as any)) {
				required.push(capStr as Capability)
			}
		})
		if (routerResult.longform) {
			preferred.push("longform")
		}
		if (routerResult.latencySensitive) {
			preferred.push("lowLatency" as Capability)
		}
	}

	// CODE erkennen (harte Gate)
	if (CODE_PATTERNS.some((re) => re.test(prompt))) {
		required.push("code")
	}
	// Reasoning erkennen
	if (REASONING_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("reasoning")
	}
	// Langformat erkennen
	if (LONGFORM_PATTERNS.some((re) => re.test(prompt)) || prompt.length > 2500) {
		preferred.push("longform")
	}
	// JSON erkennen
	if (JSON_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("json")
	}
	// Tools erkennen
	if (TOOLS_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("tools")
	}

	// Agentik-Modus: Wenn agentMode aktiv, Code und Tools als Wunsch setzen
	if (task.metadata?.agentMode === true) {
		if (!required.includes("code")) {
			preferred.push("code")
		}
		if (!preferred.includes("tools")) {
			preferred.push("tools")
		}
	}

	return {
		testTokens: estimateTokens(prompt),
		requiredCapabilities: required.length > 0 ? required : undefined,
		preferredCapabilities: preferred.length > 0 ? preferred : undefined,
		// T1-2 Vision: Bild-Anhänge machen `vision` zur Pflicht-Fähigkeit.
		hasAttachments: attachmentCount > 0,
		privacy: task.metadata?.privacy,
		budgetUsd: task.metadata?.budgetUsd,
		mode: task.metadata?.mode,
		pinnedProviderId: task.metadata?.preferredProviderId,
		pinnedModelId: task.metadata?.preferredModelId,
	}
}