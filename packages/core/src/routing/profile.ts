/**
 * Task-Profil-Extraktion (`01-plan.md` §6.1): heuristisch aus Prompt +
 * Metadaten — deterministisch, ohne LLM-Aufruf, in `shared`-Form
 * (`estTokens`, `requiredCapabilities`, …).
 */

import type { Capability, Task, TaskProfile } from "@diriz/shared"
import { estimateTokens } from "@diriz/shared"

/** Code-Task → `code` ist ein hartes Gate. */
const CODE_PATTERNS: RegExp[] = [
	/```/,
	/\b(function |def |class |interface |const |import |SELECT |CREATE TABLE |async )\b/i,
	/\b(bug|error|exception|stacktrace|crash|compile|build fail|refactor|optimisier|implementier)\b/i,
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
 */
export function extractProfile(task: Task): TaskProfile {
	const prompt = task.prompt
	const required: Capability[] = []
	const preferred: Capability[] = []

	if (CODE_PATTERNS.some((re) => re.test(prompt))) {
		required.push("code")
	}
	if (REASONING_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("reasoning")
	}
	if (LONGFORM_PATTERNS.some((re) => re.test(prompt)) || prompt.length > 2500) {
		preferred.push("longform")
	}
	if (JSON_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("json")
	}
	if (TOOLS_PATTERNS.some((re) => re.test(prompt))) {
		preferred.push("tools")
	}
	// Agentik-Modus: Das Modell soll Dateien lesen und schreiben. Damit ist die
	// Aufgabe unabhängig vom Wortlaut eine Code-Aufgabe — „bau mir eine
	// Webseite“ enthält kein einziges technisches Stichwort, verlangt aber
	// genau dieselben Fähigkeiten. Als Wunsch, nicht als Pflicht: Sonst würde
	// ein hartes Gate Modelle ausschliessen, die es vielleicht doch könnten.
	if (task.metadata.agentMode === true) {
		if (!required.includes("code")) {
			preferred.push("code")
		}
		if (!preferred.includes("tools")) {
			preferred.push("tools")
		}
	}

	return {
		estTokens: estimateTokens(task.prompt),
		requiredCapabilities: required,
		preferredCapabilities: preferred,
		privacy: task.metadata.privacy,
		budgetUsd: task.metadata.budgetUsd,
		mode: task.metadata.mode,
		pinnedProviderId: task.metadata.preferredProviderId,
		pinnedModelId: task.metadata.preferredModelId,
	}
}
