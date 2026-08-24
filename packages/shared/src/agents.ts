/**
 * Spezialisten (Agenten) & Swarms (`01-plan.md`-Erweiterung M1).
 *
 * Ein Agent = benannter Spezialist mit eigener Rolle (System-Prompt),
 * Fähigkeiten und Routing-Einschränkungen (Privacy, Provider-/Modell-Pin).
 * Ein Swarm = Gruppe von Agenten, aus der pro Prompt der beste gewählt wird.
 *
 * Die Scoring-Formel lebt hier in `shared` (rein & deterministisch), weil
 * Core (Zuordnung) und Web (Explainability-UI) dieselbe Formel brauchen —
 * keine Drift möglich.
 */

import type { Capability, ModelSettings, PrivacyMode } from "./types.js"

/** Wie eine Task einem Spezialisten zugeordnet wird. */
export type AssignmentMode = "auto" | "agent" | "swarm"

/** `any` = Agent nimmt, was das Routing hergibt; sonst feste Privacy-Vorgabe. */
export type AgentPrivacy = PrivacyMode | "any"

/** Ein benannter Spezialist mit eigener Rolle und Routing-Einschränkungen. */
export interface Agent {
	id: string
	name: string
	description: string
	systemPrompt: string
	/** Modell muss diese Fähigkeiten haben (hartes Gate im Routing). */
	requiredCapabilities: Capability[]
	/** Score-Bonus, wenn das Modell diese Fähigkeiten hat. */
	preferredCapabilities: Capability[]
	privacy: AgentPrivacy
	/** Optional: Routing auf einen konkreten Rechner bzw. ein konkretes Modell. */
	pinnedProviderId?: string | null
	pinnedInstanceId?: string | null
	/**
	 * Model-Voreinstellungen dieses Spezialisten — Quelle ist sein `init.md`
	 * (siehe `docs.ts`). Auflösung: Provider ← Modell ← **Agent** ← Task.
	 */
	modelSettings?: ModelSettings | null
	enabled: boolean
	createdAt: string
	updatedAt: string
}

/** Ein Swarm = Gruppe von Agenten; pro Prompt wird der beste ausgewählt. */
export interface Swarm {
	id: string
	name: string
	description: string
	agentIds: string[]
	enabled: boolean
	createdAt: string
	updatedAt: string
}

/** Scoring-Input eines Agenten (flache Struktur für die pure Formel). */
export interface AgentCandidate {
	agentId: string
	name: string
	description: string
	requiredCapabilities: Capability[]
	preferredCapabilities: Capability[]
	privacy: AgentPrivacy
	enabled: boolean
}

/** Ein Agent-Score mit Erklärung — Basis für die Explainability-UI. */
export interface AgentScore {
	agentId: string
	name: string
	score: number
	reasons: string[]
}

/** Kontext für die Zuordnung (aus dem Task-Profil abgeleitet). */
export interface AgentProfile {
	privacy: PrivacyMode
	requiredCapabilities: Capability[]
	preferredCapabilities: Capability[]
}

/** Untergrenze für die Auto-Zuordnung: mindestens ein relevanter Treffer. */
export const MIN_AGENT_SCORE = 1

/** Funktionswörter (DE/EN) — zählen nicht als Keywords. */
const STOPWORDS = new Set([
	// Deutsch
	"der",
	"die",
	"das",
	"und",
	"oder",
	"aber",
	"im",
	"in",
	"an",
	"am",
	"auf",
	"aus",
	"bei",
	"dem",
	"den",
	"des",
	"einem",
	"einer",
	"eines",
	"ich",
	"wir",
	"sie",
	"er",
	"es",
	"mir",
	"dir",
	"uns",
	"euch",
	"was",
	"wie",
	"warum",
	"wer",
	"wo",
	"wann",
	"dann",
	"dass",
	"also",
	"nicht",
	"nur",
	"für",
	"von",
	"zu",
	"mit",
	"ohne",
	"gegen",
	"über",
	"nach",
	"vor",
	"unter",
	"seit",
	"bis",
	"weil",
	"denn",
	"auch",
	"ja",
	"nein",
	"sehr",
	"gut",
	"mal",
	"bitte",
	"hallo",
	"mein",
	"meine",
	"schreib",
	"schreibe",
	"machen",
	"mache",
	"soll",
	"sollte",
	"kann",
	"können",
	"muss",
	"müssen",
	"will",
	"möchte",
	"möchten",
	"hier",
	"jetzt",
	"noch",
	// Englisch
	"the",
	"and",
	"or",
	"but",
	"for",
	"with",
	"without",
	"into",
	"from",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"you",
	"your",
	"we",
	"our",
	"they",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"why",
	"when",
	"where",
	"how",
	"not",
	"no",
	"yes",
	"if",
	"then",
	"than",
	"so",
	"as",
	"by",
	"please",
	"write",
	"make",
	"need",
	"needs",
	"can",
	"could",
	"would",
	"should",
	"want",
	"wants",
	"here",
	"now",
	"some",
	"any",
	"all",
	"very",
	"well",
	"hello",
	"hi",
	"me",
	"my",
])

/**
 * Tokenizer: klein, alphanumerisch (+ Umlaute), ≥ 2 Zeichen, ohne
 * Funktionswörter. Deterministisch — gleiche Eingabe, gleiche Terms.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9äöüß]+/i)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

/**
 * Bewertet alle Agenten gegen einen Prompt (deterministisch, erklärt):
 *
 * - Name im Prompt: +10 · Namens-Terms: +4 je ab **zwei** Treffern (max 8);
 *   ein einzelnes Namenswort nur +1 — sonst gewinnt ein Allerweltswort
 * - Beschreibungsterms im Prompt: +2 je (max 10)
 * - Pflicht-Fähigkeit matcht Task-Pflicht: +2 je (max 4)
 * - Wunsch-Fähigkeit matcht Task-Wunsch: +1 je (max 3)
 * - Fähigkeitsprofil passt vollständig (alle Pflicht-Fähigkeiten des Agenten
 *   deckt die Task ab): +2 — dafür braucht der Agent überhaupt Pflichtfelder
 * - Fähigkeit gefordert, die die Task nicht braucht: −1 je (max −3). Sie
 *   verengt sonst das Routing-Gate ohne Nutzen und schliesst Modelle aus
 * - Privacy: local-only-Agent bei local-only-Profil +1, Cloud-Agent −2
 *
 * Sortierung: Score absteigend, dann Name, dann ID (stabil).
 */
export function scoreAgents(prompt: string, profile: AgentProfile, agents: AgentCandidate[]): AgentScore[] {
	const promptTerms = new Set(tokenize(prompt))
	const results: AgentScore[] = []

	for (const agent of agents) {
		let score = 0
		const reasons: string[] = []

		const name = agent.name.trim()
		if (name && prompt.toLowerCase().includes(name.toLowerCase())) {
			score += 10
			reasons.push(`Name „${name}“ im Prompt`)
		}
		const nameTerms = [...new Set(tokenize(name))]
		const nameHits = nameTerms.filter((t) => promptTerms.has(t))
		if (nameHits.length >= 2) {
			score += Math.min(8, nameHits.length * 4)
			reasons.push(`Namens-Treffer: ${nameHits.slice(0, 3).join(", ")}`)
		} else if (nameHits.length === 1) {
			// **Ein** Namenswort ist ein Hinweis, kein Beweis. „Strukturierte
			// Daten“ machte sonst den Daten-Ingenieur zum Sieger einer
			// SEO-Frage, nur weil „Daten“ in seinem Namen steht — mit mehr
			// Punkten, als eine echte Beschreibungsübereinstimmung liefert.
			score += 1
			reasons.push(`Namenswort: ${nameHits[0]}`)
		}
		const descTerms = [...new Set(tokenize(agent.description))]
		const descHits = descTerms.filter((t) => promptTerms.has(t))
		if (descHits.length > 0) {
			score += Math.min(10, descHits.length * 2)
			reasons.push(`Keywords: ${descHits.slice(0, 4).join(", ")}`)
		}
		const requiredHits = agent.requiredCapabilities.filter((c) => profile.requiredCapabilities.includes(c))
		if (requiredHits.length > 0) {
			score += Math.min(4, requiredHits.length * 2)
			reasons.push(`Fähigkeiten: ${requiredHits.join(", ")}`)
		}
		const preferredHits = agent.preferredCapabilities.filter((c) => profile.preferredCapabilities.includes(c))
		if (preferredHits.length > 0) {
			score += Math.min(3, preferredHits.length)
			reasons.push(`Wunsch-Fähigkeiten: ${preferredHits.join(", ")}`)
		}
		// Fähigkeitsabgleich: Was der Agent zwingend braucht, muss die Task auch
		// brauchen. Sonst zieht er das Routing-Gate unnötig eng — ein Spezialist,
		// der `code` fordert, schliesst bei einer reinen Textaufgabe alle Modelle
		// ohne Code-Fähigkeit aus, ohne dass das jemandem nützt.
		if (agent.requiredCapabilities.length > 0) {
			const taskNeeds = new Set([...profile.requiredCapabilities, ...profile.preferredCapabilities])
			const surplus = agent.requiredCapabilities.filter((c) => !taskNeeds.has(c))
			if (surplus.length === 0) {
				score += 2
				reasons.push("Fähigkeitsprofil passt vollständig")
			} else {
				score -= Math.min(3, surplus.length)
				reasons.push(`Fordert ungenutzte Fähigkeiten: ${surplus.join(", ")}`)
			}
		}
		if (profile.privacy === "local-only") {
			if (agent.privacy === "local-only") {
				score += 1
				reasons.push("Privacy local-only")
			} else if (agent.privacy === "allow-cloud") {
				score -= 2
				reasons.push("Cloud-Agent (local-only-Penalty)")
			}
		}

		results.push({ agentId: agent.agentId, name: agent.name, score, reasons })
	}

	return results.sort(
		(a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId),
	)
}

/** Wandelt einen persistierten Agenten in einen Scoring-Kandidaten um. */
export function toAgentCandidate(agent: Agent): AgentCandidate {
	return {
		agentId: agent.id,
		name: agent.name,
		description: agent.description,
		requiredCapabilities: agent.requiredCapabilities,
		preferredCapabilities: agent.preferredCapabilities,
		privacy: agent.privacy,
		enabled: agent.enabled,
	}
}
