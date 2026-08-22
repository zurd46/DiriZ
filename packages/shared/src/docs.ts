/**
 * Deklarations-Dokumente (`plan.md`, `changelog.md`, `init.md`).
 *
 * Jeder Spezialist **und** jede LLM-Instanz (Modell auf einem Rechner) führt
 * drei Markdown-Dokumente mit sich. Alle drei sind **wirksam** — das System
 * deklariert darin, wie das Modell zu arbeiten hat:
 *
 * - `plan.md`      — Auftrag, Vorgehen, Leitplanken. Wird als **verbindliche
 *   Arbeitsanweisung** in den System-Prompt übernommen (siehe
 *   `composeSystemPrompt`); Vorlagen-Platzhalter werden dabei entfernt.
 * - `init.md`      — setzt die Voreinstellungen des LLM-Modells (Temperatur,
 *   Max-Tokens, System-Prompt, …).
 * - `changelog.md` — Änderungsprotokoll; der Core hängt Einträge automatisch an.
 *
 * Der Parser lebt in `shared`, weil Core (Anwendung im Routing) und Web
 * (Live-Vorschau) dieselbe Formel brauchen — keine Drift möglich.
 *
 * Auflösung der Model-Settings (späterer Eintrag gewinnt):
 * Provider ← **Instanz (`init.md`)** ← **Agent (`init.md`)** ← Agent-Feld ← Task.
 */

import type { ModelSettings } from "./types.js"

/** Die drei Dokumente pro Spezialist bzw. LLM-Instanz. */
export type AgentDocKind = "plan" | "changelog" | "init"

/** Alias — die Dokumente hängen nicht nur an Agenten. */
export type DocKind = AgentDocKind

/** Wem die Dokumente gehören: einem Spezialisten oder einer LLM-Instanz. */
export type DocOwnerKind = "agent" | "instance"

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

/** Dieselben drei Dokumente, aber an einer LLM-Instanz (Modell) hängend. */
export interface InstanceDoc {
	instanceId: string
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
		"Voreinstellungen für das LLM-Modell.",
		"Reihenfolge: Provider ← Instanz-init.md ← Agent-init.md ← Task-Override.",
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

/* --------------------------- plan.md → Arbeitsanweisung ---------------------- */

/**
 * Platzhalter-Zeilen der Vorlagen. Sie stehen in `defaultDoc` **und** hier —
 * eine unbearbeitete Vorlage darf das Modell nie erreichen („Schritt 1“ ist
 * keine Arbeitsanweisung). Normalisiert verglichen (klein, ohne Deko).
 */
const PLAN_PLACEHOLDERS = [
	"Wofür ist dieser Spezialist zuständig?",
	"Wofür wird dieses Modell eingesetzt?",
	"Schritt 1",
	"Schritt 2",
	"Was darf der Spezialist nicht tun?",
	"Was darf dieses Modell nicht tun?",
]

const PLACEHOLDER_SET = new Set(PLAN_PLACEHOLDERS.map((p) => normalizeKey(p)))

/** Zeile ohne Inhalt: Vorlagen-Platzhalter, TODO, Strich, `{{…}}`. */
function isPlaceholderLine(line: string): boolean {
	const text = stripMarkdown(line)
	if (text.length === 0) {
		return true
	}
	if (PLACEHOLDER_SET.has(normalizeKey(text))) {
		return true
	}
	return /^(todo|tbd|-{1,3}|—|–|\.{3}|…)$/i.test(text) || /^\{\{.*\}\}$/.test(text)
}

/** Metazeile, die im Prompt nichts verloren hat (Titel, Erstell-Datum). */
function isMetaLine(line: string): boolean {
	const text = stripMarkdown(line)
	return /^(plan|init|changelog)\.md\b/i.test(text) || /^(erstellt am|angelegt am|stand)\s*:/i.test(text)
}

/**
 * Zieht aus einem `plan.md` die tatsächliche Arbeitsanweisung heraus.
 *
 * Entfernt Titel, Erstell-Datum und alle unbearbeiteten Vorlagen-Platzhalter;
 * Überschriften ohne verbleibenden Inhalt fallen mit weg. Ergebnis ist
 * `undefined`, wenn das Dokument nie ausgefüllt wurde — dann wird auch nichts
 * deklariert und das Modell arbeitet wie zuvor.
 */
export function extractDirective(markdown: string): string | undefined {
	const lines = (markdown ?? "").split(/\r?\n/)

	// 1. Durchgang: Meta/Platzhalter raus, Struktur (Überschriften) behalten.
	type Entry = { heading: boolean; text: string }
	const kept: Entry[] = []
	for (const raw of lines) {
		const isHeading = /^\s*#{1,6}\s+/.test(raw)
		if (isHeading) {
			if (isMetaLine(raw)) {
				continue
			}
			kept.push({ heading: true, text: raw.trim() })
			continue
		}
		if (raw.trim().length === 0) {
			kept.push({ heading: false, text: "" })
			continue
		}
		if (isMetaLine(raw) || isPlaceholderLine(raw)) {
			continue
		}
		kept.push({ heading: false, text: raw.trimEnd() })
	}

	// 2. Durchgang: Überschriften ohne eigenen Inhalt fallen weg — ein „## 2.
	// Vorgehen“, dessen Punkte alle Platzhalter waren, ist keine Anweisung.
	const result: Entry[] = []
	for (let i = 0; i < kept.length; i++) {
		const entry = kept[i]
		if (!entry) {
			continue
		}
		if (!entry.heading) {
			result.push(entry)
			continue
		}
		// Nächste bedeutsame Zeile: eine weitere Überschrift → Abschnitt ist leer.
		const next = kept.slice(i + 1).find((e) => e.heading || e.text.trim().length > 0)
		if (next && !next.heading) {
			result.push(entry)
		}
	}

	const text = result
		.map((e) => e.text)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	return text.length > 0 ? text : undefined
}

/**
 * Eine Deklarations-Ebene für den System-Prompt: Instanz oder Spezialist.
 * `label` erscheint im Prompt, damit das Modell weiß, woher eine Vorgabe kommt.
 */
export interface PromptLayer {
	label: string
	/** Roher `plan.md`-Inhalt dieser Ebene. */
	plan?: string
	/** System-Prompt dieser Ebene (aus `init.md` oder dem Agenten-Feld). */
	systemPrompt?: string
}

const DIRECTIVE_HEADER = [
	"# Verbindliche Arbeitsanweisung",
	"",
	"Die folgenden Abschnitte sind die Deklaration des Systems für diesen Auftrag.",
	"Arbeite **exakt** danach: Auftrag, Vorgehen und Leitplanken sind bindend und",
	"haben Vorrang vor eigenen Annahmen oder Gewohnheiten. Widersprechen sich zwei",
	"Abschnitte, gilt der weiter unten stehende. Ist eine Vorgabe unmöglich oder",
	"unsicher, halte dich trotzdem an alle übrigen und sage ausdrücklich, welche",
	"Vorgabe du warum nicht erfüllen konntest.",
].join("\n")

/**
 * Baut den finalen System-Prompt aus den Deklarations-Ebenen.
 *
 * - **Rolle**: der zuletzt gesetzte, nicht-leere System-Prompt gewinnt
 *   (Provider ← Instanz ← Agent ← Task) — er steht ganz oben.
 * - **Anweisung**: jede Ebene mit ausgefülltem `plan.md` liefert einen
 *   Abschnitt, in der übergebenen Reihenfolge (allgemein → spezifisch).
 *
 * Ohne jede Deklaration bleibt es beim reinen System-Prompt — kein Rahmen,
 * kein zusätzlicher Text (Verhalten wie vor M9).
 */
export function composeSystemPrompt(layers: PromptLayer[]): string {
	const role = layers
		.map((l) => (l.systemPrompt ?? "").trim())
		.filter((s) => s.length > 0)
		.at(-1)

	const sections: string[] = []
	for (const layer of layers) {
		const directive = extractDirective(layer.plan ?? "")
		if (directive) {
			sections.push(`## ${layer.label} — ${AGENT_DOC_FILES.plan}\n\n${directive}`)
		}
	}

	if (sections.length === 0) {
		return role ?? ""
	}
	return [role, DIRECTIVE_HEADER, ...sections].filter((s) => s && s.length > 0).join("\n\n")
}

/* ------------------------------ Default-Inhalte ------------------------------ */

/** Systemweit einstellbare Vorlagen für die drei Dokumente. */
export type DocTemplates = Partial<Record<AgentDocKind, string>>

/** Vorlagen pro Besitzer-Art — Spezialist und LLM-Instanz sind getrennt. */
export interface DocTemplateSettings {
	agent?: DocTemplates
	instance?: DocTemplates
}

/**
 * Füllt die Platzhalter einer Vorlage: `{{name}}` (Spezialist/Modell),
 * `{{datum}}`/`{{date}}` (ISO-Tag) und `{{datei}}`/`{{file}}` (Dateiname).
 */
export function renderDocTemplate(
	template: string,
	name: string,
	isoDate: string,
	kind: AgentDocKind,
): string {
	const day = isoDate.slice(0, 10)
	return template
		.replace(/\{\{\s*(name|Name)\s*\}\}/g, name)
		.replace(/\{\{\s*(datum|date|Datum|Date)\s*\}\}/g, day)
		.replace(/\{\{\s*(datei|file|Datei|File)\s*\}\}/g, AGENT_DOC_FILES[kind])
}

/** Startinhalt eines Dokuments — angelegt, sobald Spezialist/Instanz entsteht. */
export function defaultDoc(
	kind: AgentDocKind,
	owner: DocOwnerKind,
	name: string,
	isoDate: string,
	templates?: DocTemplateSettings,
): string {
	const custom = templates?.[owner]?.[kind]
	if (custom && custom.trim().length > 0) {
		return renderDocTemplate(custom, name, isoDate, kind)
	}
	const day = isoDate.slice(0, 10)
	const isAgent = owner === "agent"
	const noun = isAgent ? "Spezialist" : "Modell"

	if (kind === "plan") {
		return [
			`# plan.md — ${name}`,
			"",
			`**Erstellt am:** ${day}`,
			"",
			"## 1. Auftrag",
			"",
			isAgent ? "Wofür ist dieser Spezialist zuständig?" : "Wofür wird dieses Modell eingesetzt?",
			"",
			"## 2. Vorgehen",
			"",
			"- Schritt 1",
			"- Schritt 2",
			"",
			"## 3. Leitplanken",
			"",
			isAgent ? "- Was darf der Spezialist nicht tun?" : "- Was darf dieses Modell nicht tun?",
			"",
		].join("\n")
	}
	if (kind === "changelog") {
		return [
			`# changelog.md — ${name}`,
			"",
			"Änderungsprotokoll (neueste Einträge oben).",
			"",
			`- ${day} — ${noun} angelegt`,
			"",
		].join("\n")
	}
	return renderInitDoc({}, name)
}

/** Rückwärtskompatibler Kurzweg für Spezialisten. */
export function defaultAgentDoc(
	kind: AgentDocKind,
	agentName: string,
	isoDate: string,
	templates?: DocTemplateSettings,
): string {
	return defaultDoc(kind, "agent", agentName, isoDate, templates)
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
