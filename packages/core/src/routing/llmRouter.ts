/** 
 * T1-3 Router-Modell (opt-in) 
 * Kleines lokales Modell klassifiziert unsichere Prompts gemäß 01-plan.md §6.1 Kaskade 2. 
 *
 * Diese Datei stellt die Kern-Routing-Engine bereit, die einen Prompt analysiert
 * und ein JSON-Output liefert mit:
 * - capabilities: erkannte Fähigkeiten (code, reasoning, longform, json, tools, vision)
 * - longform: ob der Prompt langformatig ist
 * - latencySensitive: ob Latenz-sensitiv
 *
 * Das Router-Modell ist optional und kann via Settings aktiviert/deaktiviert werden.
 * Standardmäßig fällt das System auf heuristischen Wege (profile.ts) zurück.
 */ 

import type { Task } from "@diriz/shared"
export interface LLMRouterResult {
	capabilities: string[]
	longform: boolean
	latencySensitive: boolean
}

/** 
 * Analysiert einen Prompt und gibt ein Router-Ergebnis zurück. 
 *
 * Diese Implementierung verwendet heuristische Mustererkennung (RegEx),
 * vergleichbar mit der extractProfile-Funktion in packages/core/src/routing/profile.ts.
 * Bei aktiviertem Router-Modell kann hier später ein kleines lokales Modell
 * (z.B. llama3.2:3b, qwen2.5:3b) für die Klassifizierung eingebunden werden. 
 *
 * @param prompt Der zu analysierende Prompt-Text
 * @returns Objekt mit capability-Klassifizierung
 */ 
export function analyzePrompt(prompt: string): LLMRouterResult {
	const capabilities: string[] = []
	let longform = false
	let latencySensitive = false

	// CODE-Patterns (ähnlich wie in profile.ts)
	const codePatterns: RegExp[] = [
		/```/,
		/\b(function |def |class |interface |const |import |SELECT |CREATE TABLE |async )\b/i,
		/\b(bug|error|exception|stacktrace|crash|compile|build fail|refactor|optimisier)\b/i,
		/\b\.(py|ts|tsx|js|jsx|java|go|rs|cpp|cs|sql|sh)\b/i,
		/\b(django|flask|react|node|vite|express|fastify|postgres|redis|kafka)\b/i,
	]

	const reasoningPatterns: RegExp[] = [
		/\b(analyse|analyse|diagnose|debug|optimisier|optimis|trade-?off|vergleich|compare|architektur|architecture)\b/i,
		/\b(warum|why|root cause|ursache)\b/i,
	]

	const longformPatterns: RegExp[] = [
		/\b(article|blog|essay|bericht|dokumentation|documentation|guide|tutorial|handbuch)\b/i,
		/\b(übersetze|translate|zusammenfasse|summarize|erläutere|erkläre ausführlich)\b/i,
	]

	const jsonPatterns: RegExp = /\\b(json|schema|api|endpoint|rest|graphql|yaml|config|konfiguration)\\b/i

	const toolsPatterns: RegExp[] = [
		/\b(aufrufen|call the|execute|ausführen|web-?tool|mcp|function-?calling)\b/i,
	]

	// CODE erkennen
	if (codePatterns.some((re) => re.test(prompt))) {
		capabilities.push("code")
	}

// Reasoning erkennen
	if (reasoningPatterns.some((re) => re.test(prompt))) {
		capabilities.push("reasoning")
		longform = longformPatterns.some((re) => re.test(prompt))
	}

// JSON erkennen
	if (jsonPatterns.test(prompt)) {
		capabilities.push("json")
	}

// Tools erkennen
	if (toolsPatterns.some((re) => re.test(prompt))) {
		capabilities.push("tools")
	}

// Langformat erkennen (länge > 2500 Zeichen oder longform-Muster)
	if (prompt.length > 2500 || longformPatterns.some((re) => re.test(prompt))) {
		longform = true
	}

// Latenz-sensitiv: kurze Prompts ohne komplexe Anforderungen
	const shortPromptRegex = /^\s*(erkläre|say|hello|test)\b/i
	latencySensitive = shortPromptRegex.test(prompt) || prompt.trim().length < 50

	return {
		capabilities,
		longform,
		latencySensitive,
	}
}

/** 
 * Haupt-Routing-Funktion. 
 * Liefert ein Entscheidung-Objekt basierend auf dem Prompt und den Router-Einstellungen. 
 *
 * @param task Die Task mit Prompt und Metadaten
 * @param useRouter Ob das Router-Modell aktiviert ist (opt-in)
 * @returns Routing-Entscheidung mit ausgewähltem Capability-Profil
 */ 
export function routeTask(task: Task, useRouter = false): LLMRouterResult {
	const prompt = task.prompt || ""

	// Wenn Router deaktiviert oder nicht verfügbar, falle auf Standard-Heuristik zurück
	if (!useRouter) {
		return analyzePrompt(prompt)
	}

// Bei aktiviertem Router-Modell können hier erweiterte Logik eingefügt werden:
// - Kleines lokales Modell konsultieren
// - Erweiterte Pattern-Erkennung
// - Integration mit Profil-Einstellungen

	return analyzePrompt(prompt)
}

/** 
 * Prüft, ob das Router-Modell basierend auf den Task-Metadaten aktiviert ist. *
 * @param task Die Task mit Metadaten
 * @returns Wahr, wenn Router opt-in aktiviert ist
 */ 
export function isRouterEnabled(task: Task): boolean {
	const metadata = task.metadata || ""

	// Router kann via metadata.preferredProviderId oder explicitem Flag gesteuert werden
	// Das bevorzugte Provider-Id-Präsenz zeigt an, dass der Nutzer eine bewusste Wahl trifft
	return !!(metadata.routerEnabled === true ||
		(metadata.preferredProviderId && typeof metadata.goal === "string" && metadata.goal.includes("router")))
}

/** 
 * Gibt ein menschenlesbares Label für das Router-Ergebnis zurück. *
 * @param result Das LLMRouterResult
 * @returns Beschriftung für UI-Anzeige
 */ 
export function getRouterLabel(result: LLMRouterResult): string {
	const caps = result.capabilities.join(", ") || "keine"
	const lf = result.longform ? "langformat" : ""
	const ls = result.latencySensitive ? "latenz-sensitiv" : ""

	if (caps) {
		return `${caps}${lf ?", "` + lf : ""}${ls ?", "` + ls : ""}`
	}
	return lf ? langform : ls ? latencySensitive : "standard"
}

export default {
	analyzePrompt,
	routeTask,
	isRouterEnabled,
	getRouterLabel,
}
