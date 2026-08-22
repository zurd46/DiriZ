/**
 * Agenten-Dokumente (`plan.md`, `changelog.md`, `init.md`).
 *
 * Jeder Spezialist führt drei Markdown-Dokumente mit sich:
 * - `plan.md`      — Auftrag, Vorgehen, Leitplanken (reine Doku).
 * - `changelog.md` — Änderungsprotokoll; der Core hängt Einträge automatisch an.
 * - `init.md`      — **wirksam**: setzt die Voreinstellungen des LLM-Modells
 *   (Temperatur, Max-Tokens, …). Der Parser lebt hier in `shared`, weil Core
 *   (Anwendung im Routing) und Web (Live-Vorschau) dieselbe Formel brauchen —
 *   keine Drift möglich.
 *
 * Auflösung der Model-Settings (späterer Eintrag gewinnt):
 * Provider-Default ← Modell-Override ← **Agent (`init.md`)** ← Task-Override.
 */

import type { ModelSettings } from "./types.js"

/** Die drei Dokumente pro Spezialist. */
export type AgentDocKind = "plan" | "changelog" | "init"

export const AGENT_DOC_KINDS: AgentDocKind[] = ["plan", "changelog", "init"]

/** Dateiname pro Dokumenttyp — so heißen die Dokumente auch in der UI. */
export const AGENT_DOC_FILES: Record<AgentDocKind, string> = {
	plan: "plan.md",
	changelog: "changelog.md",
	init: "init.md",
}

export interface AgentDoc {
	agentId: string
	kind: AgentDocKind
	content: string
	updatedAt: string
}

export function isAgentDocKind(value: unknown): value is AgentDocKind {
	return typeof value === "string" && (AGENT_DOC_KINDS as string[]).includes(value)
}

/* --------------------------------- init.md ---------------------------------- */

type NumericKey =
	| "temperature"
	| "topP"
	| "topK"
	| "minP"
	| "maxTokens"
	| "presencePenalty"
	| "frequencyPenalty"
	| "repeatPenalty"
	| "seed"

/** Schlüssel-Aliase (normalisiert: klein, ohne Sonderzeichen). */
const NUMERIC_ALIASES: Record<string, NumericKey> = {
	temperature: "temperature",
	temperatur: "temperature",
	temp: "temperature",
	topp: "topP",
	nucleus: "topP",
	topk: "topK",
	minp: "minP",
	maxtokens: "maxTokens",
	maxtoken: "maxTokens",
	maxoutputtokens: "maxTokens",
	maximaletokens: "maxTokens",
	presencepenalty: "presencePenalty",
	frequencypenalty: "frequencyPenalty",
	repeatpenalty: "repeatPenalty",
	repetitionpenalty: "repeatPenalty",
	seed: "seed",
}

const STOP_ALIASES = new Set(["stop", "stopwords", "stopworter", "stopwörter", "stopsequences", "stopp"])
const SYSTEM_ALIASES = new Set(["systemprompt", "system", "rolle", "role"])

/** Werte, die „nicht gesetzt“ bedeuten — Platzhalter und Striche. */
function isEmptyValue(raw: string): boolean {
	const v = raw.trim()
	return (
		v.length === 0 ||
		v === "-" ||
		v === "—" ||
		v === "–" ||
		v === "?" ||
		/^\{\{.*\}\}$/.test(v) ||
		/^(default|standard|auto|none|keine?)$/i.test(v)
	)
}

/** Entfernt Markdown-Deko (Listenpunkt, Fettung, Backticks) von einer Zeile. */
function stripMarkdown(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
		.replace(/[*_`]/g, "")
		.replace(/^#+\s*/, "")
		.trim()
}

function normalizeKey(key: string): string {
	return key
		.toLowerCase()
		.replace(/\(.*?\)/g, "")
		.replace(/[^a-zäöüß0-9]/g, "")
}

function parseNumber(raw: string): number | undefined {
	// „0.7“, „0,7“, „4096 Tokens“, „32k“ → Zahl.
	const cleaned = raw.trim().replace(/,(?=\d)/, ".")
	const m = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*([kK])?/)
	if (!m) {
		return undefined
	}
	const value = Number(m[1]) * (m[2] ? 1024 : 1)
	return Number.isFinite(value) ? value : undefined
}

function parseList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[(.*)\]$/s, "$1")
	return inner
		.split(",")
		.map((x) => x.trim().replace(/^["'`]|["'`]$/g, ""))
		.filter((x) => x.length > 0)
}

/**
 * Liest die Model-Voreinstellungen aus einem `init.md`.
 *
 * Erkannt wird jede Zeile der Form `Schlüssel: Wert` (auch als Liste, fett
 * oder in Code-Fences) — alles andere ist freier Fließtext und wird ignoriert.
 * `System-Prompt:` darf mehrzeilig sein, wenn ein Abschnitt `## System-Prompt`
 * genutzt wird: dann zählt der Text bis zur nächsten Überschrift.
 */
export function parseInitDoc(markdown: string): ModelSettings {
	const settings: ModelSettings = {}
	const lines = (markdown ?? "").split(/\r?\n/)

	let systemSection: string[] | undefined
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i] ?? ""

		// Abschnitt „## System-Prompt“ → Fließtext bis zur nächsten Überschrift.
		const heading = rawLine.match(/^\s*#{1,6}\s+(.*)$/)
		if (heading) {
			if (SYSTEM_ALIASES.has(normalizeKey(heading[1] ?? ""))) {
				systemSection = []
			} else if (systemSection) {
				settings.systemPrompt ||= systemSection.join("\n").trim() || undefined
				systemSection = undefined
			}
			continue
		}
		if (systemSection) {
			systemSection.push(rawLine)
			continue
		}

		const line = stripMarkdown(rawLine)
		const match = line.match(/^([^:=]{1,40})\s*[:=]\s*(.*)$/)
		if (!match) {
			continue
		}
		const key = normalizeKey(match[1] ?? "")
		const value = (match[2] ?? "").trim()
		if (isEmptyValue(value)) {
			continue
		}

		const numericKey = NUMERIC_ALIASES[key]
		if (numericKey) {
			const num = parseNumber(value)
			if (num !== undefined) {
				settings[numericKey] = num
			}
			continue
		}
		if (STOP_ALIASES.has(key)) {
			const stop = parseList(value)
			if (stop.length > 0) {
				settings.stop = stop
			}
			continue
		}
		if (SYSTEM_ALIASES.has(key)) {
			settings.systemPrompt = value
		}
	}
	if (systemSection) {
		settings.systemPrompt ||= systemSection.join("\n").trim() || undefined
	}
	return settings
}

const NUMERIC_LABELS: { key: NumericKey; label: string }[] = [
	{ key: "temperature", label: "Temperature" },
	{ key: "topP", label: "Top-P" },
	{ key: "topK", label: "Top-K" },
	{ key: "minP", label: "Min-P" },
	{ key: "maxTokens", label: "Max-Tokens" },
	{ key: "repeatPenalty", label: "Repeat-Penalty" },
	{ key: "presencePenalty", label: "Presence-Penalty" },
	{ key: "frequencyPenalty", label: "Frequency-Penalty" },
	{ key: "seed", label: "Seed" },
]

/**
 * Schreibt Model-Settings als `init.md` — die Umkehrung von `parseInitDoc`:
 * `parseInitDoc(renderInitDoc(s))` liefert wieder `s`.
 */
export function renderInitDoc(settings: ModelSettings, agentName?: string): string {
	const lines: string[] = [
		`# init.md${agentName ? ` — ${agentName}` : ""}`,
		"",
		"Voreinstellungen für das LLM-Modell dieses Spezialisten.",
		"Reihenfolge: Provider-Default ← Modell-Override ← **init.md** ← Task-Override.",
		"",
		"## Model-Parameter",
		"",
	]
	const set = NUMERIC_LABELS.filter(({ key }) => settings[key] !== undefined)
	if (set.length === 0 && !settings.stop?.length) {
		lines.push("- Temperature: —", "- Max-Tokens: —")
	} else {
		for (const { key, label } of set) {
			lines.push(`- ${label}: ${settings[key]}`)
		}
		if (settings.stop?.length) {
			lines.push(`- Stop: ${settings.stop.join(", ")}`)
		}
	}
	if (settings.systemPrompt?.trim()) {
		lines.push("", "## System-Prompt", "", settings.systemPrompt.trim())
	}
	lines.push("")
	return lines.join("\n")
}

/* ------------------------------ Default-Inhalte ------------------------------ */

/** Startinhalt eines Dokuments — angelegt, sobald ein Spezialist entsteht. */
export function defaultAgentDoc(kind: AgentDocKind, agentName: string, isoDate: string): string {
	const day = isoDate.slice(0, 10)
	if (kind === "plan") {
		return [
			`# plan.md — ${agentName}`,
			"",
			`**Erstellt am:** ${day}`,
			"",
			"## 1. Auftrag",
			"",
			"Wofür ist dieser Spezialist zuständig?",
			"",
			"## 2. Vorgehen",
			"",
			"- Schritt 1",
			"- Schritt 2",
			"",
			"## 3. Leitplanken",
			"",
			"- Was darf der Spezialist nicht tun?",
			"",
		].join("\n")
	}
	if (kind === "changelog") {
		return [
			`# changelog.md — ${agentName}`,
			"",
			"Änderungsprotokoll dieses Spezialisten (neueste Einträge oben).",
			"",
			`- ${day} — Spezialist angelegt`,
			"",
		].join("\n")
	}
	return renderInitDoc({}, agentName)
}

/**
 * Hängt einen Eintrag an ein `changelog.md` an — direkt unter der Überschrift
 * und dem Vorspann, damit die neuesten Einträge oben stehen.
 */
export function appendChangelogEntry(content: string, entry: string, isoDate: string): string {
	const line = `- ${isoDate.slice(0, 10)} — ${entry}`
	const lines = (content ?? "").split(/\r?\n/)
	const firstBullet = lines.findIndex((l) => /^\s*[-*+]\s+/.test(l))
	if (firstBullet === -1) {
		return `${content.trimEnd()}\n\n${line}\n`
	}
	lines.splice(firstBullet, 0, line)
	return lines.join("\n")
}
