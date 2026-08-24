/**
 * Modell-Katalog & `llm.md` — das technische Datenblatt eines LLM.
 *
 * Ein Spezialist bekommt einen Auftrag (`plan.md`: Auftrag, Vorgehen,
 * Leitplanken). Ein **Modell** bekommt keinen Auftrag — es hat Eigenschaften.
 * Die stehen in `llm.md`, und die Orchestrierung rechnet sie ein:
 *
 * | Zeile im `llm.md`      | Wirkung im System                                   |
 * |------------------------|-----------------------------------------------------|
 * | `Fähigkeiten`          | hartes Gate + Capability-Achse (25 % des Scores)     |
 * | `Werkzeuge`            | welche Datei-Werkzeuge das Modell im Agentik-Modus   |
 * |                        | aufrufen darf                                       |
 * | `Kontext-Fenster`      | hartes Gate + Context-Fit-Achse (25 %)               |
 * | `Qualitätsklasse`      | Startwert der Qualitäts-Achse (18 %), bis Feedback   |
 * |                        | aus echten Ausführungen ihn ablöst                   |
 * | `Gut für` / `Nicht …`  | Eignungs-Achse (12 %): Stärken heben, Schwächen      |
 * |                        | senken den Wert für genau diesen Prompt              |
 *
 * Woher der Inhalt kommt: Ein Provider meldet bei der Discovery nur einen
 * Modellnamen. Dieses Modul erkennt daran die Familie (lokal wie Cloud) und
 * schreibt ein ausgefülltes Datenblatt — ergänzt um das, was Parameterzahl,
 * Kontextfenster, Quantisierung und Preis verraten. Das ist eine **Vermutung**
 * und als solche gekennzeichnet; korrigiert wird sie durch Bearbeiten des
 * Dokuments, das damit zur Quelle der Wahrheit wird.
 *
 * Beim Erweitern: Die Reihenfolge in `MODEL_FAMILIES` entscheidet — spezifische
 * Regeln (Embedding, Vision, Coder, Reasoning) stehen **vor** den Familien,
 * sonst gewinnt „qwen" gegen „qwen3-coder".
 */

import { tokenize } from "./agents.js"
import { type AgentDocKind, renderInitDoc } from "./docs.js"
import type { Capability, ModelSettings } from "./types.js"

/** Wie gut die Ausgaben erfahrungsgemäß sind — Startwert der Qualitäts-Achse. */
export type ModelQuality = "hoch" | "mittel" | "niedrig"

/** Wie schnell das Modell antwortet — Notiz für die Auswahl von Hand. */
export type ModelSpeed = "schnell" | "mittel" | "langsam"

/** Qualitätsklasse → Startwert (`basisPrior`) der Qualitäts-Achse im Routing. */
export const QUALITY_PRIOR: Record<ModelQuality, number> = {
	hoch: 0.75,
	mittel: 0.6,
	niedrig: 0.45,
}

/** Das Datenblatt einer Modell-Familie. */
export interface ModelProfile {
	/** Erkannte Familie, z. B. „Code-Modell". */
	family: string
	/** Ein Satz: was für ein Modell das ist. */
	purpose: string
	/** `## Gut für` — wofür es taugt. */
	goodFor: string[]
	/** `## Nicht geeignet für` — wo es abfällt. */
	notFor: string[]
	/** `## Hinweise` — wie man es einsetzt. */
	notes: string[]
	/** `## Fähigkeiten` — wirksam: hartes Routing-Gate. */
	capabilities: Capability[]
	quality: ModelQuality
	speed: ModelSpeed
	/** Startwerte für `init.md`. */
	settings: ModelSettings
}

/** Eine Familien-Regel: Namensmuster → Datenblatt. */
export interface ModelFamilyRule {
	/** Geprüft gegen `"<modelId> <displayName>"` in Kleinschreibung. */
	test: RegExp
	profile: ModelProfile
}

/** Was über ein Modell bekannt ist, wenn das Datenblatt entsteht. */
export interface ModelIdentity {
	modelId: string
	displayName?: string
	contextWindow?: number
	/** Vom Provider gemeldete Fähigkeiten — gemessen schlägt geraten. */
	capabilities?: Capability[]
	languages?: string[]
	quantization?: string
	/** Nur Cloud (USD je Million Token). */
	pricePerMTok?: { in: number; out: number }
}

/** Das, was `parseLlmDoc` aus einem Datenblatt herausliest. */
export interface ModelSpec {
	family?: string
	parameters?: number
	contextWindow?: number
	quantization?: string
	languages: string[]
	capabilities: Capability[]
	quality?: ModelQuality
	speed?: ModelSpeed
	goodFor: string[]
	notFor: string[]
	/** Freigegebene Werkzeuge des Agentik-Modus. */
	tools: AgentTool[]
}

const CAPABILITY_VALUES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]

/**
 * Die Werkzeuge, die DiriZ im Agentik-Modus anbietet (`core/execution/tools.ts`).
 * Sie stehen im Datenblatt, damit pro Modell entschieden werden kann, was es
 * anfassen darf: Ein Modell, das Werkzeugaufrufe nicht sauber beherrscht,
 * schreibt sonst Dateien mit halb geratenen Pfaden.
 */
export const AGENT_TOOLS = ["list_files", "read_file", "write_file"] as const

export type AgentTool = (typeof AGENT_TOOLS)[number]

/** Was jedes Werkzeug tut — die Kurzfassung fürs Datenblatt. */
export const AGENT_TOOL_HINTS: Record<AgentTool, string> = {
	list_files: "listet die Dateien im Workspace der Task",
	read_file: "liest eine Datei aus dem Workspace (max. 100 kB)",
	write_file: "schreibt oder überschreibt eine Datei im Workspace",
}

/* ------------------------------- Der Katalog --------------------------------- */

/** Die Familien, nach Spezifität geordnet. Erste Übereinstimmung gewinnt. */
export const MODEL_FAMILIES: ModelFamilyRule[] = [
	{
		// Zuerst, weil `bge-m3`, `e5` & Co. sonst als Chat-Modelle durchgehen.
		test: /embed|bge-|gte-|e5-|minilm|arctic-embed|sentence-transformer|text-embedding/,
		profile: {
			family: "Embedding-Modell",
			purpose: "Wandelt Text in Vektoren um. Kein Chat-Modell — es beantwortet keine Fragen.",
			goodFor: [
				"Ähnlichkeitssuche, Clustering, RAG-Retrieval",
				"sehr schnelle, sehr günstige Massenverarbeitung",
			],
			notFor: ["Aufträge jeder Art — die Ausgabe ist unbrauchbar", "Fliesstext, Code, Analyse"],
			notes: [
				"Für Index und Abfrage denselben Modellstand verwenden, sonst passen die Vektoren nicht zusammen.",
				"Im Routing deaktiviert lassen (Modell im Rechner-Tab abschalten).",
			],
			capabilities: [],
			quality: "niedrig",
			speed: "schnell",
			settings: { temperature: 0, maxTokens: 512 },
		},
	},
	{
		test: /rerank/,
		profile: {
			family: "Reranker",
			purpose: "Sortiert gefundene Textstellen nach Relevanz zu einer Frage. Kein Chat-Modell.",
			goodFor: ["Trefferlisten aus der Vektorsuche nachschärfen"],
			notFor: ["Aufträge jeder Art", "Antworten formulieren, zusammenfassen"],
			notes: ["Immer als zweite Stufe nach einer Vektorsuche einsetzen."],
			capabilities: [],
			quality: "niedrig",
			speed: "schnell",
			settings: { temperature: 0, maxTokens: 512 },
		},
	},
	{
		test: /sqlcoder|sql-coder|nsql/,
		profile: {
			family: "SQL-Spezialist",
			purpose: "Übersetzt Fragen in SQL-Abfragen gegen ein mitgegebenes Schema.",
			goodFor: [
				"SELECT-Abfragen aus natürlicher Sprache",
				"Joins, Aggregate, Fensterfunktionen",
				"vorhandene Abfragen an ein Schema anpassen",
			],
			notFor: ["allgemeine Programmieraufgaben", "Fliesstext und Analyse"],
			notes: [
				"Ohne vollständiges Schema (Tabellen, Spalten, Typen) rät das Modell Spaltennamen.",
				"SQL-Dialekt im Prompt nennen (PostgreSQL, SQLite, MySQL …).",
			],
			capabilities: ["code"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.1, maxTokens: 2048 },
		},
	},
	{
		test: /llava|bakllava|moondream|minicpm-v|internvl|pixtral|[-\s]vl\b|vl-|vision|florence/,
		profile: {
			family: "Vision-Modell",
			purpose: "Versteht Bilder und Text zugleich: beschreibt, liest und beurteilt Bildinhalte.",
			goodFor: [
				"Screenshots und Oberflächen beschreiben (UI-Review, Fehlerbilder)",
				"Text aus Bildern lesen (OCR-artige Aufgaben)",
				"Diagramme, Tabellen und Skizzen erklären",
			],
			notFor: ["reine Textaufgaben — dort ist ein Allzweck-Modell besser", "lange Fliesstexte"],
			notes: [
				"Bild plus konkrete Frage übergeben; offene Aufforderungen liefern nur eine Bildbeschreibung.",
				"Nicht erkennbare Stellen benennen lassen, statt sie raten zu lassen.",
			],
			capabilities: ["vision"],
			quality: "mittel",
			speed: "mittel",
			settings: { temperature: 0.3, maxTokens: 2048 },
		},
	},
	{
		test: /coder|codellama|code-llama|starcoder|codegemma|codestral|stable-code|magicoder|wizardcoder|granite-code|codeqwen|codegeex|opencoder|devstral/,
		profile: {
			family: "Code-Modell",
			purpose: "Auf Quellcode trainiert: schreibt, ergänzt, erklärt und repariert Programme.",
			goodFor: [
				"Funktionen und Module aus einer Beschreibung schreiben",
				"Fehlersuche, Refactoring, Tests nachziehen",
				"Code erklären und in eine andere Sprache übertragen",
				"strukturierte Ausgaben: JSON, Diff, Patch",
			],
			notFor: [
				"lange Fliesstexte und freies Formulieren",
				"Faktenfragen — das Weltwissen ist zugunsten von Code beschnitten",
			],
			notes: [
				"Vollständige Dateien mit Pfad übergeben statt Ausschnitte; das Modell hält sich an gezeigte Konventionen.",
				"Niedrige Temperatur (0.1–0.3) — Kreativität ist hier ein Fehler.",
			],
			capabilities: ["code", "json"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.2, maxTokens: 4096 },
		},
	},
	{
		test: /deepseek-?r1|(^|[-\s/])r1[-\s]|qwq|marco-o1|magistral|reasoner|thinking|phi-4-reasoning|(^|\/)o[134](-|$)/,
		profile: {
			family: "Reasoning-Modell",
			purpose: "Denkt eine Aufgabe sichtbar durch, bevor es antwortet — Genauigkeit vor Tempo.",
			goodFor: [
				"mehrstufige Analysen, Mathematik, Logik",
				"Architektur- und Trade-off-Entscheidungen begründen",
				"schwierige Fehlersuche ohne offensichtliche Ursache",
				"Pläne prüfen und Lücken darin finden",
			],
			notFor: [
				"einfache oder häufige Aufträge — die Denkphase kostet Zeit und Token",
				"knappe Antworten unter Zeitdruck",
			],
			notes: [
				"Max-Tokens grosszügig setzen: Zu kleine Limits schneiden die Antwort mitten in der Denkphase ab.",
				"Temperatur um 0.6 lassen — niedriger bringt es aus dem Tritt.",
			],
			capabilities: ["reasoning", "longform"],
			quality: "hoch",
			speed: "langsam",
			settings: { temperature: 0.6, maxTokens: 8192 },
		},
	},
	{
		test: /gpt-oss/,
		profile: {
			family: "GPT-OSS",
			purpose: "Offenes GPT-Modell mit einstellbarer Denktiefe und verlässlicher Werkzeugnutzung.",
			goodFor: [
				"agentische Aufträge mit Werkzeug- und Funktionsaufrufen",
				"Analyse und Code auf gutem Niveau, lokal betrieben",
				"strukturierte Ausgaben, JSON",
			],
			notFor: ["Fragen zu aktuellen Ereignissen", "Betrieb auf kleiner Hardware"],
			notes: ["Denktiefe zur Aufgabe wählen: knapp für Routine, hoch für Analyse."],
			capabilities: ["reasoning", "code", "tools", "json"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /qwen/,
		profile: {
			family: "Qwen",
			purpose: "Vielseitiges Allzweck-Modell mit starker Mehrsprachigkeit und solidem Code-Anteil.",
			goodFor: [
				"allgemeine Aufträge: erklären, zusammenfassen, umformulieren",
				"Code und strukturierte Ausgaben (JSON)",
				"Deutsch, Englisch und weitere Sprachen, auch Übersetzung",
				"Werkzeugaufrufe (ab Qwen 2.5)",
			],
			notFor: ["Faktenfragen zu aktuellen Ereignissen", "sehr lange Ketten von Schlussfolgerungen"],
			notes: ["Hält sich gut an Formatvorgaben — gewünschte Ergebnisform ausdrücklich nennen."],
			capabilities: ["reasoning", "code", "json"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /llama[-\s]?[34]|llama3|meta-llama/,
		profile: {
			family: "Llama",
			purpose: "Solides Allzweck-Modell für Alltagsaufträge: erklären, entwerfen, formulieren.",
			goodFor: [
				"Unterhaltung, Erklärungen, Zusammenfassungen",
				"Entwürfe für Texte, Konzepte und einfache Programme",
				"Werkzeugaufrufe (ab 3.1) und JSON-Ausgaben",
			],
			notFor: ["anspruchsvoller Code", "tiefe mehrstufige Analyse", "Aktuelles"],
			notes: ["Ein Beispiel für die gewünschte Ergebnisform hebt die Trefferquote spürbar."],
			capabilities: ["reasoning", "tools", "json"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /mixtral/,
		profile: {
			family: "Mixtral (Mixture of Experts)",
			purpose: "Breites Wissen bei moderater Rechenlast pro Antwort — dafür hoher Speicherbedarf.",
			goodFor: [
				"lange Texte verfassen und redigieren",
				"europäische Sprachen, Übersetzung",
				"Analyse grosser Eingaben",
			],
			notFor: ["Code auf Spezialisten-Niveau", "Rechner mit knappem Speicher"],
			notes: ["Struktur vorgeben (Abschnitte, Reihenfolge), sonst schweift die Antwort aus."],
			capabilities: ["longform", "reasoning"],
			quality: "mittel",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /mistral|ministral|nemo/,
		profile: {
			family: "Mistral",
			purpose: "Schnelles, sparsames Allzweck-Modell für kurze, klare Antworten.",
			goodFor: [
				"häufige Routineaufträge mit knapper Antwort",
				"Zusammenfassen, Umformulieren, Klassifizieren",
				"Werkzeugaufrufe und JSON",
				"Französisch, Deutsch, Englisch",
			],
			notFor: ["tiefe, mehrstufige Analysen", "sehr lange Eingaben"],
			notes: ["Spielt seinen Vorteil bei vielen kurzen Aufträgen aus, nicht bei einem grossen."],
			capabilities: ["tools", "json", "reasoning"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.6, maxTokens: 3072 },
		},
	},
	{
		test: /gemma/,
		profile: {
			family: "Gemma",
			purpose: "Kompaktes Modell für knappe, sauber formulierte Antworten.",
			goodFor: [
				"kurze Erklärungen und Zusammenfassungen",
				"guter Sprachstil, auch auf Deutsch",
				"Betrieb auf kleiner Hardware",
			],
			notFor: ["Werkzeugaufrufe", "umfangreicher Code", "lange Ketten von Schlussfolgerungen"],
			notes: ["Eine Aufgabe pro Anfrage; verkettete Aufträge verwässern das Ergebnis."],
			capabilities: ["reasoning"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.7, maxTokens: 2048 },
		},
	},
	{
		test: /phi-?[34]|phi3|phi4/,
		profile: {
			family: "Phi",
			purpose: "Kleines Modell mit auffällig guter Logik für seine Grösse — knapp und sachlich.",
			goodFor: [
				"Logik- und Mathematikaufgaben im kleinen Rahmen",
				"strukturierte, kurze Antworten",
				"sehr geringer Ressourcenbedarf",
			],
			notFor: ["Faktenfragen — wenig Weltwissen", "Werkzeugaufrufe", "lange Texte"],
			notes: ["Vorwiegend auf Englisch trainiert; deutsche Ausgaben gegenlesen."],
			capabilities: ["reasoning"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.4, maxTokens: 2048 },
		},
	},
	{
		test: /granite/,
		profile: {
			family: "Granite",
			purpose: "Auf Unternehmensaufgaben zugeschnitten: RAG, Werkzeuge, feste Ausgabeschemata.",
			goodFor: [
				"Antworten strikt aus mitgelieferten Dokumenten (RAG)",
				"Werkzeug- und Funktionsaufrufe",
				"JSON nach Schema",
			],
			notFor: ["freies Weltwissen ohne Quellen", "kreatives Schreiben"],
			notes: ["Quellen mitgeben und verlangen, dass nur daraus geantwortet wird."],
			capabilities: ["tools", "json", "longform"],
			quality: "mittel",
			speed: "mittel",
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /command-r|cohere/,
		profile: {
			family: "Command R",
			purpose: "Auf RAG und Werkzeugnutzung ausgelegt: antwortet belegt statt aus dem Gedächtnis.",
			goodFor: [
				"belegte Antworten mit Quellenangabe aus grossem Kontext",
				"mehrstufige Werkzeugaufrufe",
				"Mehrsprachigkeit",
			],
			notFor: ["kreatives Schreiben", "Faktenaussagen ohne mitgegebene Quellen"],
			notes: ["Zitate mit Fundstelle verlangen; fehlende Belege als Lücke melden lassen."],
			capabilities: ["tools", "longform", "json"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /aya|nllb|madlad|towerinstruct/,
		profile: {
			family: "Übersetzungs-Modell",
			purpose: "Auf Sprachen und Übersetzung spezialisiert.",
			goodFor: [
				"Übersetzung in und aus vielen Sprachen",
				"Ton und Register beim Übersetzen halten",
				"mehrsprachige Zusammenfassungen",
			],
			notFor: ["Code", "tiefe Analyse"],
			notes: ["Ausgangs- und Zielsprache sowie den Ton nennen; feste Fachbegriffe vorab auflisten."],
			capabilities: ["longform"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /dolphin|hermes|nous-|openchat|zephyr|vicuna|orca|neural-chat|solar|tulu/,
		profile: {
			family: "Community-Feintuning",
			purpose: "Auf Anweisungstreue feinabgestimmtes Chat-Modell: hält sich eng an Rolle und Format.",
			goodFor: ["genaue Rollen- und Formatvorgaben", "Unterhaltung und Entwürfe", "JSON-Treue"],
			notFor: ["regulierte Inhalte — Trainingsdaten selten dokumentiert", "Faktenfragen"],
			notes: ["Qualität schwankt je nach Feintuning; erste Ergebnisse stichprobenartig prüfen."],
			capabilities: ["json", "reasoning"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.7, maxTokens: 3072 },
		},
	},
	{
		test: /yi-|glm|internlm|baichuan|ernie|kimi|moonshot/,
		profile: {
			family: "Allzweck (asiatische Familien)",
			purpose: "Allzweck-Modell mit grossem Kontextfenster und breitem Wissen.",
			goodFor: ["lange Eingaben verarbeiten", "Zusammenfassung und Analyse", "Chinesisch und Englisch"],
			notFor: ["deutscher Feinschliff — Sprachqualität schwankt", "Aktuelles"],
			notes: ["Kontextfenster für Dokumentanalysen nutzen; deutsche Ausgaben gegenlesen."],
			capabilities: ["longform", "reasoning"],
			quality: "mittel",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /deepseek/,
		profile: {
			family: "DeepSeek",
			purpose: "Leistungsfähiges Allzweck-Modell mit besonderer Stärke bei Code und Analyse.",
			goodFor: [
				"Code schreiben, prüfen und erklären",
				"technische Analyse und Mathematik",
				"gutes Verhältnis von Leistung zu Kosten",
			],
			notFor: ["Aktuelles", "deutschen Feinschliff ohne Gegenlesen"],
			notes: ["Technische Aufträge mit vollständigem Kontext und klarer Ergebnisform übergeben."],
			capabilities: ["code", "reasoning", "json"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /(^|\/)gpt-[45]|chatgpt/,
		profile: {
			family: "OpenAI GPT (Cloud)",
			purpose: "Starkes Allzweck-Modell aus der Cloud: breites Wissen, verlässliche Werkzeugnutzung.",
			goodFor: [
				"anspruchsvolle Analyse, Code und Fliesstext",
				"Werkzeug- und Funktionsaufrufe, strukturierte Ausgaben",
				"gutes Deutsch ohne Nachbearbeitung",
			],
			notFor: [
				"vertrauliche Daten ohne Freigabe — Privacy-Modus `allow-cloud` nötig",
				"Massenaufträge, die lokal genauso gut laufen",
			],
			notes: ["Kontext knapp halten: Jedes Token kostet."],
			capabilities: ["reasoning", "code", "tools", "json", "longform"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /claude/,
		profile: {
			family: "Anthropic Claude (Cloud)",
			purpose: "Starkes Cloud-Modell mit besonderer Stärke bei langen Texten, Code und Agentik.",
			goodFor: [
				"grosse Kontexte: ganze Dateien und Dokumente am Stück",
				"Code schreiben und überarbeiten, agentische Abläufe",
				"präzises, gut formuliertes Deutsch",
			],
			notFor: ["vertrauliche Daten ohne Freigabe (`allow-cloud`)", "Massenaufträge aus Kostengründen"],
			notes: ["Ganze Dateien statt Ausschnitte übergeben — das Kontextfenster trägt es."],
			capabilities: ["reasoning", "code", "tools", "json", "longform"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /gemini/,
		profile: {
			family: "Google Gemini (Cloud)",
			purpose: "Cloud-Modell mit sehr grossem Kontextfenster und Bildverständnis.",
			goodFor: [
				"sehr lange Eingaben (ganze Repositories, Bücher)",
				"Bild- und Dokumentanalyse",
				"günstige schnelle Varianten für Routine",
			],
			notFor: ["vertrauliche Daten ohne Freigabe (`allow-cloud`)", "feste Ausgabeformate ohne Vorgabe"],
			notes: ["Für Routine die schnelle Variante wählen, für Analyse die grosse."],
			capabilities: ["longform", "vision", "reasoning", "json"],
			quality: "hoch",
			speed: "schnell",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /sonar|perplexity/,
		profile: {
			family: "Web-Recherche (Cloud)",
			purpose: "Recherchiert im Web und antwortet mit Quellenangabe.",
			goodFor: ["aktuelle Informationen samt Fundstellen", "Faktencheck, Marktüberblick"],
			notFor: ["vertrauliche Daten — die Anfrage geht ins Web", "Code und lange Analyse"],
			notes: ["Frage eng stellen, Zeitraum nennen, Quellenangabe verlangen."],
			capabilities: ["longform"],
			quality: "mittel",
			speed: "mittel",
			settings: { temperature: 0.3, maxTokens: 3072 },
		},
	},
	{
		test: /grok/,
		profile: {
			family: "xAI Grok (Cloud)",
			purpose: "Cloud-Allzweckmodell mit grossem Kontext und lockerem Ton.",
			goodFor: ["allgemeine Aufträge und Code", "grosses Kontextfenster"],
			notFor: ["vertrauliche Daten ohne Freigabe (`allow-cloud`)", "streng sachliche Ausgaben ohne Vorgabe"],
			notes: ["Ton ausdrücklich vorgeben, wenn es nüchtern bleiben soll."],
			capabilities: ["reasoning", "code", "longform"],
			quality: "hoch",
			speed: "mittel",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /nemotron|nvidia/,
		profile: {
			family: "Nemotron",
			purpose: "Auf Durchsatz optimiertes Allzweck-Modell mit gutem Anweisungsverhalten.",
			goodFor: ["allgemeine Aufträge", "Werkzeugaufrufe", "Code auf mittlerem Niveau"],
			notFor: ["Aktuelles", "sehr lange Ketten von Schlussfolgerungen"],
			notes: ["Ergebnisform ausdrücklich vorgeben."],
			capabilities: ["reasoning", "tools", "json"],
			quality: "mittel",
			speed: "schnell",
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
]

/** Wenn keine Familie greift — ehrlich unbestimmt statt falsch behauptet. */
const GENERIC_PROFILE: ModelProfile = {
	family: "Unbekannte Familie",
	purpose: "Allgemeines Sprachmodell. Der Zuschnitt ist DiriZ nicht bekannt und sollte geprüft werden.",
	goodFor: ["allgemeine Textaufgaben: erklären, zusammenfassen, umformulieren", "Entwürfe zum Nachprüfen"],
	notFor: ["Aufträge, bei denen ein Fehler teuer wird — solange dieses Datenblatt ungeprüft ist"],
	notes: [
		"Erste Aufträge beobachten und dieses Dokument danach schärfen: Fähigkeiten und Qualitätsklasse wirken sofort im Routing.",
	],
	capabilities: [],
	quality: "mittel",
	speed: "mittel",
	settings: { temperature: 0.7, maxTokens: 4096 },
}

/* ------------------------------- Heuristiken --------------------------------- */

/**
 * Parameterzahl in Milliarden aus dem Namen — `8b`, `1.5b`, `8x7b` (→ 56),
 * `30b-a3b` (→ 30). `undefined`, wenn der Name nichts hergibt (Cloud).
 */
export function parameterCount(name: string): number | undefined {
	const m = name.toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?\s*b(?![a-z0-9])/)
	if (!m) {
		return undefined
	}
	const first = Number(m[1])
	const second = m[2] ? Number(m[2]) : undefined
	const value = second === undefined ? first : first * second
	return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Grössenklasse → was man dem Modell zumuten kann. */
function sizeNote(params: number): { goodFor: string; notFor: string; quality: ModelQuality; speed: ModelSpeed } {
	if (params <= 4) {
		return {
			goodFor: `sehr klein (${params} Mrd. Parameter): schnelle Routine, Vorfilter, Klassifikation`,
			notFor: "mehrstufige Analysen und lange Texte — dafür fehlt die Kapazität",
			quality: "niedrig",
			speed: "schnell",
		}
	}
	if (params <= 15) {
		return {
			goodFor: `mittlere Grösse (${params} Mrd. Parameter): guter Kompromiss aus Tempo und Qualität`,
			notFor: "Aufträge, bei denen die erste Antwort ungeprüft übernommen wird",
			quality: "mittel",
			speed: "schnell",
		}
	}
	if (params <= 40) {
		return {
			goodFor: `gross (${params} Mrd. Parameter): belastbar auch bei anspruchsvollen Aufträgen`,
			notFor: "parallele Aufträge auf demselben Rechner — der Speicher reicht selten für zwei",
			quality: "hoch",
			speed: "mittel",
		}
	}
	return {
		goodFor: `sehr gross (${params} Mrd. Parameter): höchste Qualität auf diesem Rechner`,
		notFor: "Aufträge unter Zeitdruck — Ladezeit und Rechenzeit sind erheblich",
		quality: "hoch",
		speed: "langsam",
	}
}

/** Quantisierung → was sie in der Praxis bedeutet. */
function quantizationNote(quantization: string): { note: string; downgrade: boolean } | undefined {
	const q = quantization.toLowerCase()
	if (/q2|q3|iq[123]/.test(q)) {
		return {
			note: `Stark quantisiert (${quantization}): Ausgaben werden ungenauer — Zahlen, Namen und Code nachprüfen.`,
			downgrade: true,
		}
	}
	if (/q4/.test(q)) {
		return {
			note: `Quantisiert (${quantization}): guter Kompromiss; bei exakten Zahlen und Zitaten trotzdem nachprüfen.`,
			downgrade: false,
		}
	}
	return undefined
}

/** Fügt hinzu, was noch nicht drinsteht — Reihenfolge bleibt erhalten. */
function withUnique<T>(list: T[], ...additions: (T | undefined)[]): T[] {
	const out = [...list]
	for (const item of additions) {
		if (item !== undefined && !out.includes(item)) {
			out.push(item)
		}
	}
	return out
}

/** Eine Stufe schlechter — für stark quantisierte oder sehr kleine Modelle. */
function downgrade(quality: ModelQuality): ModelQuality {
	return quality === "hoch" ? "mittel" : "niedrig"
}

/**
 * Das Datenblatt zu einem Modell: Familie über den Namen, danach ergänzt um
 * das, was Parameterzahl, Kontextfenster, Quantisierung und Preis verraten.
 *
 * Vom Provider gemeldete Fähigkeiten gewinnen immer — sie sind gemessen, das
 * Profil ist geraten.
 */
export function profileForModel(identity: ModelIdentity): ModelProfile {
	const haystack = `${identity.modelId} ${identity.displayName ?? ""}`.toLowerCase()
	const base = MODEL_FAMILIES.find((rule) => rule.test.test(haystack))?.profile ?? GENERIC_PROFILE
	const isTool = base.capabilities.length === 0 && base.quality === "niedrig" // Embedding/Reranker

	const goodFor = [...base.goodFor]
	const notFor = [...base.notFor]
	const notes = [...base.notes]
	let capabilities = [...base.capabilities]
	let quality = base.quality
	let speed = base.speed

	const params = parameterCount(haystack)
	if (params !== undefined && !isTool) {
		const note = sizeNote(params)
		goodFor.push(note.goodFor)
		notFor.push(note.notFor)
		speed = note.speed
		// Die Familie sagt, wofür das Modell taugt; die Grösse begrenzt es.
		if (note.quality === "niedrig" || (note.quality === "mittel" && quality === "hoch")) {
			quality = note.quality
		}
	}

	const ctx = identity.contextWindow
	if (ctx !== undefined && ctx > 0 && !isTool) {
		if (ctx >= 32768) {
			goodFor.push(`grosses Kontextfenster (${kTokens(ctx)}): ganze Dateien und Dokumente am Stück`)
			capabilities = withUnique(capabilities, "longform")
		} else if (ctx <= 8192) {
			notFor.push(`lange Eingaben — das Kontextfenster fasst nur ${kTokens(ctx)}`)
			capabilities = capabilities.filter((c) => c !== "longform")
		}
	}

	const quant = identity.quantization ? quantizationNote(identity.quantization) : undefined
	if (quant) {
		notes.push(quant.note)
		if (quant.downgrade) {
			quality = downgrade(quality)
		}
	}

	const price = identity.pricePerMTok
	if (price && (price.in > 0 || price.out > 0)) {
		notes.push("Kostet Geld: Kontext knapp halten und Routine lokal erledigen.")
	}

	// Gemessen schlägt geraten.
	if (identity.capabilities && identity.capabilities.length > 0) {
		capabilities = withUnique(capabilities, ...identity.capabilities)
	}

	return { ...base, goodFor, notFor, notes, capabilities, quality, speed, settings: { ...base.settings } }
}

function kTokens(contextWindow: number): string {
	return contextWindow >= 1024 ? `${Math.round(contextWindow / 1024)}k Token` : `${contextWindow} Token`
}

/* --------------------------------- llm.md ------------------------------------ */

/**
 * Schreibt das Datenblatt. Aufbau und Schlüsselwörter sind der Kontrakt mit
 * `parseLlmDoc`: `parseLlmDoc(renderLlmDoc(x))` liefert die Angaben zurück.
 */
export function renderLlmDoc(identity: ModelIdentity, isoDate: string): string {
	const profile = profileForModel(identity)
	const name = identity.displayName || identity.modelId
	const params = parameterCount(`${identity.modelId} ${identity.displayName ?? ""}`)
	const price = identity.pricePerMTok

	const lines: string[] = [
		`# llm.md — ${name}`,
		"",
		`**Erstellt am:** ${isoDate.slice(0, 10)}`,
		"",
		"Technisches Datenblatt dieses Modells. DiriZ liest es aus und rechnet es in die",
		"Orchestrierung ein: **Fähigkeiten** und **Kontext-Fenster** sind harte Gates,",
		"**Gut für**/**Nicht geeignet für** bewegen die Eignungs-Achse, **Werkzeuge**",
		"regeln den Agentik-Modus, die **Qualitätsklasse** ist der Startwert der",
		"Qualitäts-Achse. Die Angaben unten",
		"stammen aus dem Modell-Katalog und sind eine Vermutung anhand des Modellnamens —",
		"korrigiere sie hier, sobald du das Modell im Einsatz gesehen hast.",
		"",
		"## Steckbrief",
		"",
		`- Modell-ID: ${identity.modelId}`,
		`- Familie: ${profile.family}`,
	]
	if (params !== undefined) {
		lines.push(`- Parameter: ${params} Mrd.`)
	}
	lines.push(`- Kontext-Fenster: ${identity.contextWindow ?? "—"}`)
	if (identity.quantization) {
		lines.push(`- Quantisierung: ${identity.quantization}`)
	}
	lines.push(
		`- Preis: ${price && (price.in > 0 || price.out > 0) ? `${price.in} $ ein / ${price.out} $ aus je Mio. Token` : "lokal (keine Kosten)"}`,
	)
	if (identity.languages?.length) {
		lines.push(`- Sprachen: ${identity.languages.join(", ")}`)
	}
	lines.push(
		`- Qualitätsklasse: ${profile.quality}`,
		`- Tempo: ${profile.speed}`,
		"",
		"## Zweck",
		"",
		profile.purpose,
		"",
		"## Fähigkeiten",
		"",
	)
	lines.push(
		...(profile.capabilities.length > 0
			? profile.capabilities.map((c) => `- ${c}`)
			: ["- keine (dieses Modell beantwortet keine Aufträge)"]),
	)
	// Werkzeuge: nur, wenn das Modell Werkzeugaufrufe überhaupt beherrscht —
	// sonst steht dort eine Freigabe, die niemand einlösen kann.
	const toolsAllowed = profile.capabilities.includes("tools")
	lines.push("", "## Werkzeuge", "")
	lines.push(
		...(toolsAllowed
			? AGENT_TOOLS.map((t) => `- ${t} — ${AGENT_TOOL_HINTS[t]}`)
			: ["- keine (dieses Modell ruft im Agentik-Modus keine Werkzeuge auf)"]),
	)
	lines.push(
		"",
		"## Gut für",
		"",
		...profile.goodFor.map((s) => `- ${s}`),
		"",
		"## Nicht geeignet für",
		"",
		...profile.notFor.map((s) => `- ${s}`),
		"",
		"## Hinweise",
		"",
		...profile.notes.map((s) => `- ${s}`),
		"",
	)
	return lines.join("\n")
}

/* ------------------------------ Parser (wirksam) ----------------------------- */

function normalizeKey(key: string): string {
	return key
		.toLowerCase()
		.replace(/\(.*?\)/g, "")
		.replace(/[^a-zäöüß0-9]/g, "")
}

/** Entfernt Listenpunkt, Fettung und Backticks. */
function stripMarkdown(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
		.replace(/[*_`]/g, "")
		.replace(/^#+\s*/, "")
		.trim()
}

function isEmptyValue(raw: string): boolean {
	const v = raw.trim()
	return v.length === 0 || /^[-—–?]$/.test(v) || /^\{\{.*\}\}$/.test(v) || /^(keine?|unbekannt)$/i.test(v)
}

/** „32768", „32k", „128 000" → Zahl. */
function parseNumber(raw: string): number | undefined {
	const cleaned = raw.trim().replace(/[\s'.](?=\d{3}\b)/g, "").replace(/,(?=\d)/, ".")
	const m = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*([kK])?/)
	if (!m) {
		return undefined
	}
	const value = Number(m[1]) * (m[2] ? 1024 : 1)
	return Number.isFinite(value) ? value : undefined
}

const SECTION_KEYS: Record<string, "capabilities" | "goodFor" | "notFor" | "tools"> = {
	werkzeuge: "tools",
	tools: "tools",
	fähigkeiten: "capabilities",
	fahigkeiten: "capabilities",
	capabilities: "capabilities",
	gutfür: "goodFor",
	gutfur: "goodFor",
	geeignetfür: "goodFor",
	geeignetfur: "goodFor",
	stärken: "goodFor",
	starken: "goodFor",
	nichtgeeignetfür: "notFor",
	nichtgeeignetfur: "notFor",
	nichtgutfür: "notFor",
	nichtgutfur: "notFor",
	schwächen: "notFor",
	schwachen: "notFor",
	grenzen: "notFor",
}

/**
 * Liest das Datenblatt zurück.
 *
 * Erkannt wird jede Zeile `Schlüssel: Wert` im Steckbrief sowie die
 * Aufzählungen unter `## Fähigkeiten`, `## Gut für` und
 * `## Nicht geeignet für`. Alles andere ist Fliesstext und wird ignoriert —
 * das Dokument bleibt für Menschen frei beschreibbar.
 */
export function parseLlmDoc(markdown: string): ModelSpec {
	const spec: ModelSpec = { languages: [], capabilities: [], goodFor: [], notFor: [], tools: [] }
	let section: "capabilities" | "goodFor" | "notFor" | "tools" | undefined

	for (const rawLine of (markdown ?? "").split(/\r?\n/)) {
		const heading = rawLine.match(/^\s*#{1,6}\s+(.*)$/)
		if (heading) {
			section = SECTION_KEYS[normalizeKey(heading[1] ?? "")]
			continue
		}

		const line = stripMarkdown(rawLine)
		if (line.length === 0) {
			continue
		}

		const pair = line.match(/^([^:=]{1,40})\s*[:=]\s*(.*)$/)
		if (pair && !isEmptyValue(pair[2] ?? "")) {
			const key = normalizeKey(pair[1] ?? "")
			const value = (pair[2] ?? "").trim()
			if (key === "familie" || key === "family") {
				spec.family = value
			} else if (key === "parameter" || key === "parameters") {
				spec.parameters = parseNumber(value)
			} else if (key === "kontextfenster" || key === "kontext" || key === "contextwindow") {
				spec.contextWindow = parseNumber(value)
			} else if (key === "quantisierung" || key === "quantization") {
				spec.quantization = value
			} else if (key === "sprachen" || key === "languages") {
				spec.languages = value.split(",").map((x) => x.trim()).filter((x) => x.length > 0)
			} else if (key === "qualitätsklasse" || key === "qualitatsklasse" || key === "qualität" || key === "qualitat") {
				const q = value.toLowerCase()
				spec.quality = q.startsWith("hoch") ? "hoch" : q.startsWith("niedrig") ? "niedrig" : "mittel"
			} else if (key === "tempo" || key === "speed") {
				const s = value.toLowerCase()
				spec.speed = s.startsWith("schnell") ? "schnell" : s.startsWith("langsam") ? "langsam" : "mittel"
			} else if (key === "werkzeuge" || key === "tools") {
				for (const part of value.split(",")) {
					const tool = part.trim().toLowerCase() as AgentTool
					if (AGENT_TOOLS.includes(tool) && !spec.tools.includes(tool)) {
						spec.tools.push(tool)
					}
				}
			} else if (key === "fähigkeiten" || key === "fahigkeiten" || key === "capabilities") {
				// Auch die Einzeiler-Schreibweise „Fähigkeiten: code, json".
				for (const part of value.split(",")) {
					const cap = part.trim().toLowerCase() as Capability
					if (CAPABILITY_VALUES.includes(cap) && !spec.capabilities.includes(cap)) {
						spec.capabilities.push(cap)
					}
				}
			}
			// Ein `Schlüssel: Wert` beendet keine Aufzählung — Steckbrief und
			// Abschnitte stehen nie im selben Block.
			continue
		}

		if (!section) {
			continue
		}
		if (section === "capabilities") {
			const cap = line.toLowerCase().split(/[\s,(]/)[0] as Capability
			if (CAPABILITY_VALUES.includes(cap) && !spec.capabilities.includes(cap)) {
				spec.capabilities.push(cap)
			}
			continue
		}
		if (section === "tools") {
			// „- read_file — liest …" → `read_file`.
			const tool = line.toLowerCase().split(/[\s,—:(]/)[0] as AgentTool
			if (AGENT_TOOLS.includes(tool) && !spec.tools.includes(tool)) {
				spec.tools.push(tool)
			}
			continue
		}
		if (!isEmptyValue(line)) {
			spec[section].push(line)
		}
	}
	return spec
}

/** Startwert der Qualitäts-Achse aus dem Datenblatt (Default: `mittel`). */
export function qualityPriorOf(spec: ModelSpec | undefined): number {
	return QUALITY_PRIOR[spec?.quality ?? "mittel"]
}

/* -------------------------------- Dokumente ---------------------------------- */

/**
 * Die Startdokumente einer LLM-Instanz — befüllt statt leere Vorlage.
 * Das `changelog.md` hält fest, dass das Profil geraten und ungeprüft ist.
 */
export function instanceDocs(identity: ModelIdentity, isoDate: string): Partial<Record<AgentDocKind, string>> {
	const profile = profileForModel(identity)
	const name = identity.displayName || identity.modelId
	const day = isoDate.slice(0, 10)
	return {
		llm: renderLlmDoc(identity, isoDate),
		changelog: [
			`# changelog.md — ${name}`,
			"",
			"Änderungsprotokoll (neueste Einträge oben).",
			"",
			`- ${day} — Modell entdeckt, Datenblatt „${profile.family}" aus dem Modell-Katalog übernommen (ungeprüft)`,
			"",
		].join("\n"),
		init: renderInitDoc(profile.settings, name),
	}
}

/* ---------------------- Eignung: Stärken/Schwächen im Routing ----------------- */

/** Das Ergebnis von `specFitScore` — mit Begründung für die Explainability. */
export interface SpecFit {
	/** 0–1. 0.6 = neutral (kein Datenblatt oder keine Berührung mit dem Prompt). */
	value: number
	/** Getroffene Zeilen aus `## Gut für`. */
	hits: string[]
	/** Getroffene Zeilen aus `## Nicht geeignet für`. */
	misses: string[]
}

/** Neutralwert, wenn das Datenblatt zum Prompt nichts sagt. */
const SPEC_FIT_NEUTRAL = 0.6

/**
 * Tragende Wörter, auf ihren Wortstamm gekürzt.
 *
 * Nur lange Wörter zählen — kurze Allerweltswörter erzeugen Zufallstreffer.
 * Die Kürzung auf fünf Zeichen ist die einfachste Form von Stemming und im
 * Deutschen nötig: „Funktion" und „Funktionen", „schreibt" und „schreiben"
 * sind dasselbe Wort, und ein exakter Vergleich fände keines davon.
 */
function specTerms(text: string): string[] {
	return [...new Set(tokenize(text).filter((t) => t.length >= 4).map((t) => t.slice(0, 5)))]
}

/**
 * Wie gut passt dieses Modell laut seinem `llm.md` zu diesem Prompt?
 *
 * Jede Zeile unter `## Gut für`, die den Prompt inhaltlich berührt, hebt den
 * Wert um 0.1; jede Zeile unter `## Nicht geeignet für` senkt ihn um 0.25 —
 * eine ausdrückliche Schwäche wiegt schwerer als eine Stärke, weil ein
 * ungeeignetes Modell echte Arbeit vernichtet, während ein bloss nicht
 * besonders geeignetes sie nur langsamer erledigt.
 *
 * „Berührt" heisst: mindestens zwei tragende Wörter der Zeile stehen (im
 * Wortstamm) im Prompt; bei einwortigen Zeilen genügt eines. Ohne Datenblatt bleibt es neutral —
 * ein ungepflegtes Modell wird nicht bestraft, aber auch nicht bevorzugt.
 */
export function specFitScore(spec: ModelSpec | undefined, prompt: string): SpecFit {
	if (!spec || (spec.goodFor.length === 0 && spec.notFor.length === 0)) {
		return { value: SPEC_FIT_NEUTRAL, hits: [], misses: [] }
	}
	const promptTerms = new Set(specTerms(prompt))
	const touches = (line: string): boolean => {
		const terms = specTerms(line)
		if (terms.length === 0) {
			return false
		}
		const hits = terms.filter((t) => promptTerms.has(t)).length
		return terms.length === 1 ? hits === 1 : hits >= 2
	}

	const hits = spec.goodFor.filter(touches)
	const misses = spec.notFor.filter(touches)
	const value = Math.max(0, Math.min(1, SPEC_FIT_NEUTRAL + 0.1 * hits.length - 0.25 * misses.length))
	return { value, hits, misses }
}

/**
 * Schreibt geänderte Steckbrief-Werte zurück ins Datenblatt, ohne den übrigen
 * Text anzufassen.
 *
 * Nötig, weil dieselben Angaben an zwei Stellen bearbeitbar sind: im
 * Modell-Formular (Rechner-Ansicht) und im Dokument selbst. Ohne Rückschreiben
 * würden sie auseinanderlaufen, und der nächste Speichervorgang im Dokument
 * hätte die Formular-Eingabe stillschweigend überschrieben.
 */
export function updateLlmDoc(
	markdown: string,
	patch: { contextWindow?: number; capabilities?: Capability[] },
): string {
	let out = markdown ?? ""

	if (patch.contextWindow !== undefined) {
		const line = /^(\s*(?:[-*+]\s*)?\**\s*Kontext-?Fenster\**\s*[:=]\s*).*$/im
		out = line.test(out)
			? out.replace(line, `$1${patch.contextWindow}`)
			: out.replace(/(##\s*Steckbrief\s*\n)/i, `$1\n- Kontext-Fenster: ${patch.contextWindow}\n`)
	}

	if (patch.capabilities) {
		const bullets =
			patch.capabilities.length > 0
				? patch.capabilities.map((c) => `- ${c}`).join("\n")
				: "- keine (dieses Modell beantwortet keine Aufträge)"
		const section = /(^|\n)(#{1,6}\s*Fähigkeiten\s*\n)([\s\S]*?)(?=\n#{1,6}\s|\n*$)/i
		if (section.test(out)) {
			out = out.replace(section, `$1$2\n${bullets}\n`)
		} else {
			const inline = /^(\s*(?:[-*+]\s*)?\**\s*Fähigkeiten\**\s*[:=]\s*).*$/im
			out = inline.test(out)
				? out.replace(inline, `$1${patch.capabilities.join(", ")}`)
				: `${out.trimEnd()}\n\n## Fähigkeiten\n\n${bullets}\n`
		}
	}

	return out
}
