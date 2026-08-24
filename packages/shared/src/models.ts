/**
 * Modell-Katalog: wofür ein LLM taugt.
 *
 * Ein Provider meldet bei der Discovery nur seinen Modellnamen — sonst nichts.
 * Damit steht in `plan.md` einer frisch entdeckten LLM-Instanz bisher die
 * unausgefüllte Vorlage („Wofür wird dieses Modell eingesetzt?"), und
 * `extractDirective` wirft genau die als Platzhalter wieder weg: Das Modell
 * bekommt also **keine** Deklaration, und das Routing sieht ein Modell ohne
 * Fähigkeiten.
 *
 * Dieses Modul schliesst die Lücke. Es kennt die verbreiteten Modell-Familien
 * (lokal wie Cloud) und leitet aus dem Modellnamen ein Profil ab: Auftrag,
 * Stärken, Einsatz, Leitplanken, Fähigkeiten und sinnvolle Startwerte für
 * `init.md`. Was der Name nicht hergibt, ergänzen Heuristiken über
 * Parameterzahl, Kontextfenster, Quantisierung und Preis.
 *
 * Wie der Team-Katalog ist das eine **Vorlage, kein Gesetz**: Der Core schreibt
 * das Profil beim Anlegen einmal in die Dokumente; danach ist es ein ganz
 * normales, bearbeitbares `plan.md`.
 *
 * Beim Erweitern: Die Reihenfolge in `MODEL_FAMILIES` entscheidet — spezifische
 * Regeln (Coder, Vision, Reasoning) stehen **vor** den Familien-Regeln, sonst
 * gewinnt „qwen" gegen „qwen2.5-coder".
 */

import { type AgentDocKind, renderInitDoc } from "./docs.js"
import type { Capability, ModelSettings } from "./types.js"

/** Was ein Modell taugt — die Vorlage für die Dokumente einer LLM-Instanz. */
export interface ModelProfile {
	/** Erkannte Familie, z. B. „Qwen-Coder". `Unbekannt`, wenn nur Heuristik griff. */
	family: string
	/** `plan.md` §1 — wofür dieses Modell eingesetzt wird (ein Satz). */
	mission: string
	/** `plan.md` §1 — wofür es gerufen wird; zugleich die Kurzfassung in der UI. */
	strengths: string[]
	/** `plan.md` §2 — wie man es einsetzt, damit es seine Stärke ausspielt. */
	usage: string[]
	/** `plan.md` §3 — wo es abfällt und was es deshalb nicht tun soll. */
	limits: string[]
	/** Fähigkeiten für das Routing-Gate (`scoreAgents`, `policies`). */
	capabilities: Capability[]
	/** Startwerte für `init.md`. */
	settings: ModelSettings
}

/** Eine Familien-Regel: Namensmuster → Profil. */
export interface ModelFamilyRule {
	/** Geprüft gegen `"<modelId> <displayName>"` in Kleinschreibung. */
	test: RegExp
	profile: ModelProfile
}

/** Was über ein Modell bekannt ist, wenn das Profil gesucht wird. */
export interface ModelIdentity {
	modelId: string
	displayName?: string
	contextWindow?: number
	/** Vom Provider gemeldete Fähigkeiten — sie schlagen die Vermutung. */
	capabilities?: Capability[]
	quantization?: string
	/** Nur Cloud (USD je Million Token). */
	pricePerMTok?: { in: number; out: number }
}

/* ------------------------------- Der Katalog --------------------------------- */

/**
 * Die Familien, nach Spezifität geordnet. Erste Übereinstimmung gewinnt.
 *
 * Die Texte sind bewusst in der Anrede formuliert: Der `plan.md`-Inhalt landet
 * über `composeSystemPrompt` als verbindliche Arbeitsanweisung im System-Prompt
 * — dort ist „Formuliere knapp" nützlich, „Das Modell ist knapp" nicht.
 */
export const MODEL_FAMILIES: ModelFamilyRule[] = [
	{
		// Zuerst, weil `bge-m3`, `e5` & Co. sonst als Chat-Modelle durchgehen.
		test: /embed|bge-|gte-|e5-|minilm|arctic-embed|sentence-transformer|text-embedding/,
		profile: {
			family: "Embedding-Modell",
			mission:
				"Du bist ein Einbettungs-Modell: Du wandelst Text in Vektoren um und führst keine Unterhaltung.",
			strengths: [
				"Vektoren für Ähnlichkeitssuche, Clustering und RAG-Retrieval",
				"sehr schnell und sehr günstig pro Dokument",
			],
			usage: [
				"Nur für Einbettungen aufrufen — Chunking und Suche passieren ausserhalb.",
				"Denselben Modellstand für Index und Abfrage verwenden, sonst passen die Vektoren nicht zusammen.",
			],
			limits: [
				"Beantworte keine Fragen und schreibe keinen Fliesstext — dafür fehlt dem Modell der Chat-Kopf.",
				"Nicht ins Routing für Aufträge aufnehmen; es liefert dort unbrauchbare Ausgaben.",
			],
			capabilities: [],
			settings: { temperature: 0, maxTokens: 512 },
		},
	},
	{
		test: /rerank/,
		profile: {
			family: "Reranker",
			mission:
				"Du bist ein Reranker: Du sortierst gefundene Textstellen nach Relevanz zu einer Frage — mehr nicht.",
			strengths: [
				"Trefferlisten aus der Vektorsuche nachschärfen",
				"kurze Laufzeit pro Paar (Frage, Stelle)",
			],
			usage: [
				"Immer als zweite Stufe nach einer Vektorsuche einsetzen.",
				"Nur Paare (Frage, Textstelle) übergeben und eine Rangfolge zurückgeben.",
			],
			limits: [
				"Schreibe keine Antworten und fasse nichts zusammen.",
				"Nicht als Chat-Modell ins Routing aufnehmen.",
			],
			capabilities: [],
			settings: { temperature: 0, maxTokens: 512 },
		},
	},
	{
		test: /sqlcoder|sql-coder|nsql/,
		profile: {
			family: "SQL-Spezialist",
			mission: "Du bist auf SQL spezialisiert: Du übersetzt Fragen in Abfragen gegen ein gegebenes Schema.",
			strengths: [
				"SELECT-Abfragen aus natürlicher Sprache",
				"Joins, Aggregate, Fensterfunktionen",
				"Abfragen an ein vorgegebenes Schema anpassen",
			],
			usage: [
				"Immer das vollständige Schema (Tabellen, Spalten, Typen) mitgeben — ohne Schema rät das Modell Spaltennamen.",
				"Den SQL-Dialekt nennen (PostgreSQL, SQLite, MySQL …).",
				"Nur die Abfrage ausgeben, dazu eine Zeile, was sie liefert.",
			],
			limits: [
				"Keine schreibenden Anweisungen (INSERT/UPDATE/DELETE/DROP) ohne ausdrückliche Aufforderung.",
				"Keine allgemeinen Programmier- oder Fliesstext-Aufgaben — dafür ist ein anderes Modell zuständig.",
			],
			capabilities: ["code"],
			settings: { temperature: 0.1, maxTokens: 2048 },
		},
	},
	{
		test: /llava|bakllava|moondream|minicpm-v|internvl|pixtral|[-\s]vl\b|vl-|vision|florence|granite.*vision/,
		profile: {
			family: "Vision-Modell",
			mission:
				"Du bist ein Bild-und-Text-Modell: Du beschreibst, liest und beurteilst Bildinhalte und beantwortest Fragen dazu.",
			strengths: [
				"Screenshots und Oberflächen beschreiben (UI-Review, Fehlerbilder)",
				"Text aus Bildern lesen (OCR-artige Aufgaben)",
				"Diagramme, Tabellen und Skizzen erklären",
			],
			usage: [
				"Bild plus konkrete Frage übergeben — offene Aufforderungen liefern nur eine Bildbeschreibung.",
				"Bei Text im Bild wörtlich zitieren, statt sinngemäss wiederzugeben.",
				"Unlesbare oder abgeschnittene Stellen ausdrücklich als solche benennen.",
			],
			limits: [
				"Rate nichts, was im Bild nicht zu sehen ist — nicht erkennbar heisst \u201enicht erkennbar\u201c.",
				"Reine Textaufgaben laufen besser auf einem allgemeinen Modell.",
			],
			capabilities: ["vision"],
			settings: { temperature: 0.3, maxTokens: 2048 },
		},
	},
	{
		test: /coder|codellama|code-llama|starcoder|codegemma|codestral|stable-code|magicoder|wizardcoder|granite-code|codeqwen|codegeex|opencoder/,
		profile: {
			family: "Code-Modell",
			mission: "Du bist ein auf Quellcode trainiertes Modell: Du schreibst, ergänzt und reparierst Code.",
			strengths: [
				"Funktionen und Module aus einer Beschreibung schreiben",
				"Fehlersuche, Refactoring, Tests nachziehen",
				"Code erklären und in eine andere Sprache übertragen",
				"strukturierte Ausgaben (JSON, Diff, Patch)",
			],
			usage: [
				"Vollständige, lauffähige Dateien oder Blöcke ausgeben — mit Dateipfad darüber.",
				"Vorhandene Konventionen des gezeigten Codes übernehmen statt eigene einzuführen.",
				"Annahmen über nicht gezeigte Stellen benennen, statt sie zu erfinden.",
			],
			limits: [
				"Keine Bibliotheken, APIs oder Flags erfinden — unbekannt heisst offen.",
				"Kein ausschweifender Fliesstext; die Erklärung bleibt kurz, der Code steht im Mittelpunkt.",
			],
			capabilities: ["code", "json"],
			settings: { temperature: 0.2, maxTokens: 4096 },
		},
	},
	{
		test: /deepseek-?r1|(^|[-\s/])r1[-\s]|qwq|marco-o1|magistral|reasoner|thinking|phi-4-reasoning|(^|\/)o[134](-|$)/,
		profile: {
			family: "Reasoning-Modell",
			mission:
				"Du bist ein Reasoning-Modell: Du denkst eine Aufgabe erst vollständig durch und antwortest dann.",
			strengths: [
				"mehrstufige Analysen, Mathematik, Logik",
				"Architektur- und Trade-off-Entscheidungen begründen",
				"schwierige Fehlersuche, bei der die Ursache nicht offensichtlich ist",
				"Pläne prüfen und Lücken darin finden",
			],
			usage: [
				"Genug Zeit und Token einräumen — die Denkphase braucht Platz, kurze Limits schneiden die Antwort ab.",
				"Am Ende eine klare, kurze Schlussfolgerung liefern; die Herleitung bleibt darüber.",
				"Bei Unsicherheit die Alternativen mit ihren Konsequenzen nennen statt nur eine Variante.",
			],
			limits: [
				"Nicht für einfache, schnelle Aufgaben verwenden — das kostet nur Zeit.",
				"Die Denkphase ist kein Ergebnis: Sie ersetzt weder Code noch Entscheidung.",
			],
			capabilities: ["reasoning", "longform"],
			settings: { temperature: 0.6, maxTokens: 8192 },
		},
	},
	{
		test: /gpt-oss/,
		profile: {
			family: "GPT-OSS",
			mission: "Du bist ein offenes GPT-Modell mit einstellbarer Denktiefe und solider Werkzeugnutzung.",
			strengths: [
				"Werkzeug- und Funktionsaufrufe (agentische Aufträge)",
				"Analyse und Code auf gutem Niveau — lokal betrieben",
				"strukturierte Ausgaben, JSON",
			],
			usage: [
				"Denktiefe zur Aufgabe wählen: knapp für Routine, hoch für Analyse.",
				"Werkzeuge nutzen, statt Ergebnisse zu vermuten.",
			],
			limits: [
				"Kein Wissen über Ereignisse nach dem Trainingsstand — Aktuelles nachschlagen.",
				"Bei sehr grossen Kontexten auf die belegte GPU achten.",
			],
			capabilities: ["reasoning", "code", "tools", "json"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /qwen/,
		profile: {
			family: "Qwen",
			mission: "Du bist ein vielseitiges Allzweck-Modell mit starker Mehrsprachigkeit und gutem Code-Anteil.",
			strengths: [
				"allgemeine Aufgaben: erklären, zusammenfassen, umformulieren",
				"Code und strukturierte Ausgaben (JSON)",
				"Deutsch, Englisch und weitere Sprachen, auch Übersetzung",
				"Werkzeugaufrufe in den neueren Ständen",
			],
			usage: [
				"Aufgabe und gewünschte Ergebnisform klar benennen — das Modell hält sich gut an Formatvorgaben.",
				"Für Code die Zielsprache und Version nennen.",
			],
			limits: [
				"Nicht als Faktenquelle für Aktuelles verwenden.",
				"Bei sehr langen Ketten von Schlussfolgerungen ein Reasoning-Modell vorziehen.",
			],
			capabilities: ["reasoning", "code", "json"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /llama[-\s]?[34]|llama3|meta-llama/,
		profile: {
			family: "Llama",
			mission:
				"Du bist ein solides Allzweck-Modell für Alltagsaufträge: erklären, entwerfen, formulieren, einfacher Code.",
			strengths: [
				"Unterhaltung, Erklärungen, Zusammenfassungen",
				"Entwürfe für Texte, Konzepte und einfache Programme",
				"Werkzeugaufrufe (ab 3.1) und JSON-Ausgaben",
			],
			usage: [
				"Kurz und konkret anweisen; ein Beispiel für die Ergebnisform hilft spürbar.",
				"Auf Deutsch antworten lassen, aber technische Begriffe englisch belassen.",
			],
			limits: [
				"Bei anspruchsvollem Code oder tiefer Analyse ein Code- bzw. Reasoning-Modell vorziehen.",
				"Kein Wissen über Aktuelles — Fakten belegen oder als offen kennzeichnen.",
			],
			capabilities: ["reasoning", "tools", "json"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /mixtral/,
		profile: {
			family: "Mixtral (MoE)",
			mission: "Du bist ein Mixture-of-Experts-Modell: breites Wissen bei moderater Rechenlast pro Antwort.",
			strengths: [
				"lange Texte verfassen und redigieren",
				"europäische Sprachen, Übersetzung",
				"allgemeine Analyse und Zusammenfassung grosser Eingaben",
			],
			usage: [
				"Gut für Aufträge mit viel Eingabetext — Kontextfenster ausnutzen.",
				"Struktur vorgeben (Abschnitte, Reihenfolge), sonst schweift die Antwort aus.",
			],
			limits: [
				"Hoher Speicherbedarf trotz moderater Rechenzeit — auf die belegte GPU achten.",
				"Bei Code ein spezialisiertes Modell vorziehen.",
			],
			capabilities: ["longform", "reasoning"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /mistral|ministral|nemo|devstral/,
		profile: {
			family: "Mistral",
			mission: "Du bist ein schnelles, sparsames Allzweck-Modell für kurze, klare Antworten.",
			strengths: [
				"schnelle Antworten bei kleinem Ressourcenbedarf",
				"Zusammenfassen, Umformulieren, Klassifizieren",
				"Werkzeugaufrufe und JSON",
				"Französisch, Deutsch, Englisch",
			],
			usage: [
				"Für kurze, häufige Aufträge einsetzen — dort spielt es seine Geschwindigkeit aus.",
				"Ergebnisform knapp vorgeben; es hält sich gut daran.",
			],
			limits: [
				"Keine tiefen, mehrstufigen Analysen — dafür ist ein grösseres Modell zuständig.",
				"Bei sehr langen Eingaben Qualität stichprobenartig prüfen.",
			],
			capabilities: ["tools", "json", "reasoning"],
			settings: { temperature: 0.6, maxTokens: 3072 },
		},
	},
	{
		test: /gemma/,
		profile: {
			family: "Gemma",
			mission: "Du bist ein kompaktes Modell für knappe, gut formulierte Antworten.",
			strengths: [
				"kurze Erklärungen und Zusammenfassungen",
				"sauberer Sprachstil, auch auf Deutsch",
				"günstig im Betrieb, läuft auf kleiner Hardware",
			],
			usage: [
				"Eine Aufgabe pro Anfrage — verkettete Aufträge verwässern das Ergebnis.",
				"Länge und Form ausdrücklich vorgeben.",
			],
			limits: [
				"Schwach bei Werkzeugaufrufen und langen Ketten von Schlussfolgerungen.",
				"Für umfangreichen Code ein Code-Modell verwenden.",
			],
			capabilities: ["reasoning"],
			settings: { temperature: 0.7, maxTokens: 2048 },
		},
	},
	{
		test: /phi-?[34]|phi3|phi4/,
		profile: {
			family: "Phi",
			mission: "Du bist ein kleines Modell mit auffällig guter Logik für seine Grösse — knapp und sachlich.",
			strengths: [
				"Logik- und Mathematikaufgaben im kleinen Rahmen",
				"strukturierte, kurze Antworten",
				"sehr geringer Ressourcenbedarf",
			],
			usage: [
				"Aufgaben klein schneiden; Schritt für Schritt statt alles auf einmal.",
				"Auf Englisch trainiert — deutsche Antworten prüfen, wenn Formulierung zählt.",
			],
			limits: [
				"Wenig Weltwissen — keine Faktenfragen ohne Beleg.",
				"Kein Werkzeugeinsatz und keine langen Texte.",
			],
			capabilities: ["reasoning"],
			settings: { temperature: 0.4, maxTokens: 2048 },
		},
	},
	{
		test: /granite/,
		profile: {
			family: "Granite",
			mission:
				"Du bist ein auf Unternehmensaufgaben zugeschnittenes Modell: RAG, Werkzeuge, strukturierte Ausgaben.",
			strengths: [
				"Antworten strikt aus mitgelieferten Dokumenten (RAG)",
				"Werkzeug- und Funktionsaufrufe",
				"JSON und feste Ausgabeschemata",
			],
			usage: [
				"Quellen mitgeben und ausdrücklich verlangen, dass nur daraus geantwortet wird.",
				"Fehlende Angaben als Lücke melden statt zu ergänzen.",
			],
			limits: ["Kein freies Weltwissen — ohne Quellen keine Faktenaussage.", "Kein kreatives Schreiben."],
			capabilities: ["tools", "json", "longform"],
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /command-r|cohere/,
		profile: {
			family: "Command R",
			mission:
				"Du bist auf RAG und Werkzeugnutzung ausgelegt: Du antwortest belegt und rufst Werkzeuge auf, statt zu raten.",
			strengths: [
				"belegte Antworten mit Quellenangabe aus grossem Kontext",
				"mehrstufige Werkzeugaufrufe",
				"Mehrsprachigkeit",
			],
			usage: [
				"Dokumente mitgeben und Zitate mit Fundstelle verlangen.",
				"Bei fehlender Quelle die Lücke benennen.",
			],
			limits: ["Kein kreatives Schreiben.", "Ohne Quellen keine Faktenaussage."],
			capabilities: ["tools", "longform", "json"],
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /aya|nllb|madlad|towerinstruct/,
		profile: {
			family: "Mehrsprachigkeit",
			mission: "Du bist auf Sprachen und Übersetzung spezialisiert.",
			strengths: [
				"Übersetzung in und aus vielen Sprachen",
				"Ton und Register beim Übersetzen halten",
				"mehrsprachige Zusammenfassungen",
			],
			usage: [
				"Ausgangs- und Zielsprache nennen, dazu den gewünschten Ton (formal/locker).",
				"Fachbegriffe, die unübersetzt bleiben sollen, vorab auflisten.",
			],
			limits: ["Kein Code, keine tiefe Analyse.", "Fachtexte durch eine Fachperson prüfen lassen."],
			capabilities: ["longform"],
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /dolphin|hermes|nous-|openchat|zephyr|vicuna|orca|neural-chat|solar|tulu/,
		profile: {
			family: "Community-Feintuning",
			mission:
				"Du bist ein auf Anweisungstreue feinabgestimmtes Chat-Modell: Du hältst dich eng an Format und Rolle.",
			strengths: [
				"Rollen- und Formatvorgaben genau einhalten",
				"Unterhaltung und Entwürfe",
				"oft gute JSON-Treue",
			],
			usage: [
				"Rolle und Ausgabeform präzise vorgeben — daraus zieht dieses Modell seinen Vorteil.",
				"Ergebnisse stichprobenartig prüfen; Feintunings schwanken in der Qualität.",
			],
			limits: [
				"Herkunft der Trainingsdaten ist selten dokumentiert — nicht für regulierte Inhalte.",
				"Keine Faktenquelle.",
			],
			capabilities: ["json", "reasoning"],
			settings: { temperature: 0.7, maxTokens: 3072 },
		},
	},
	{
		test: /yi-|glm|internlm|baichuan|ernie/,
		profile: {
			family: "Allzweck (asiatische Familien)",
			mission: "Du bist ein Allzweck-Modell mit grossem Kontextfenster und breitem Wissen.",
			strengths: [
				"lange Eingaben verarbeiten",
				"Zusammenfassung und Analyse",
				"Chinesisch und Englisch besonders stark",
			],
			usage: [
				"Deutsche Ausgaben gegenlesen — die Sprachqualität schwankt.",
				"Kontextfenster für Dokumentanalysen nutzen.",
			],
			limits: ["Nicht für deutschen Feinschliff.", "Keine Faktenquelle für Aktuelles."],
			capabilities: ["longform", "reasoning"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /deepseek/,
		profile: {
			family: "DeepSeek",
			mission: "Du bist ein leistungsfähiges Allzweck-Modell mit besonderer Stärke bei Code und Analyse.",
			strengths: [
				"Code schreiben, prüfen und erklären",
				"technische Analyse und Mathematik",
				"gutes Preis-Leistungs-Verhältnis",
			],
			usage: [
				"Technische Aufträge mit vollständigem Kontext übergeben.",
				"Ergebnisform vorgeben (Diff, Datei, JSON).",
			],
			limits: ["Kein Wissen über Aktuelles.", "Deutsche Formulierungen gegenlesen."],
			capabilities: ["code", "reasoning", "json"],
			settings: { temperature: 0.4, maxTokens: 4096 },
		},
	},
	{
		test: /(^|\/)gpt-[45]|chatgpt/,
		profile: {
			family: "OpenAI GPT",
			mission:
				"Du bist ein starkes Allzweck-Modell aus der Cloud: breites Wissen, zuverlässige Werkzeugnutzung, saubere Formate.",
			strengths: [
				"anspruchsvolle Analyse, Code und Fliesstext",
				"Werkzeug- und Funktionsaufrufe, strukturierte Ausgaben",
				"gutes Deutsch ohne Nachbearbeitung",
			],
			usage: [
				"Für Aufträge einsetzen, an denen lokale Modelle scheitern — sonst lokal bleiben.",
				"Kontext knapp halten: Jedes Token kostet.",
			],
			limits: [
				"Cloud-Modell: keine vertraulichen Daten ohne Freigabe (`allow-cloud`).",
				"Kosten pro Auftrag im Blick behalten.",
			],
			capabilities: ["reasoning", "code", "tools", "json", "longform"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /claude/,
		profile: {
			family: "Anthropic Claude",
			mission:
				"Du bist ein starkes Allzweck-Modell aus der Cloud mit besonderer Stärke bei langen Texten und Code.",
			strengths: [
				"grosse Kontexte: ganze Dateien und Dokumente am Stück",
				"Code schreiben und überarbeiten, agentische Abläufe",
				"präzises, gut formuliertes Deutsch",
			],
			usage: [
				"Ganze Dateien statt Ausschnitte übergeben — das Kontextfenster trägt es.",
				"Ergebnisform und Umfang klar vorgeben.",
			],
			limits: [
				"Cloud-Modell: keine vertraulichen Daten ohne Freigabe (`allow-cloud`).",
				"Kosten pro Auftrag im Blick behalten.",
			],
			capabilities: ["reasoning", "code", "tools", "json", "longform"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /gemini|gemma-?pro/,
		profile: {
			family: "Google Gemini",
			mission: "Du bist ein Cloud-Modell mit sehr grossem Kontextfenster und Bildverständnis.",
			strengths: [
				"sehr lange Eingaben (ganze Repositories, Bücher)",
				"Bild- und Dokumentanalyse",
				"schnelle, günstige Varianten für Routine",
			],
			usage: [
				"Grosse Dokumentmengen am Stück analysieren lassen.",
				"Für Routine die schnelle Variante wählen, für Analyse die grosse.",
			],
			limits: [
				"Cloud-Modell: keine vertraulichen Daten ohne Freigabe (`allow-cloud`).",
				"Ausgabeformate schwanken — Format ausdrücklich vorgeben.",
			],
			capabilities: ["longform", "vision", "reasoning", "json"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
	{
		test: /sonar|perplexity/,
		profile: {
			family: "Web-Recherche",
			mission: "Du recherchierst im Web und antwortest mit Quellenangabe.",
			strengths: ["aktuelle Informationen inklusive Fundstellen", "Faktencheck und Marktüberblick"],
			usage: ["Frage eng stellen und Quellenangabe verlangen.", "Zeitraum nennen, wenn Aktualität zählt."],
			limits: [
				"Cloud-Modell mit Web-Zugriff: keine vertraulichen Daten in der Anfrage.",
				"Kein Code und keine lange Analyse.",
			],
			capabilities: ["longform"],
			settings: { temperature: 0.3, maxTokens: 3072 },
		},
	},
	{
		test: /grok/,
		profile: {
			family: "xAI Grok",
			mission: "Du bist ein Cloud-Allzweckmodell mit grossem Kontext und lockerem Ton.",
			strengths: ["allgemeine Aufgaben und Code", "grosses Kontextfenster"],
			usage: ["Ton ausdrücklich vorgeben, wenn es sachlich bleiben soll."],
			limits: [
				"Cloud-Modell: keine vertraulichen Daten ohne Freigabe (`allow-cloud`).",
				"Ausgaben auf Sachlichkeit prüfen.",
			],
			capabilities: ["reasoning", "code", "longform"],
			settings: { temperature: 0.7, maxTokens: 4096 },
		},
	},
]

/** Wenn keine Familie greift — ehrlich unbestimmt statt falsch behauptet. */
const GENERIC_PROFILE: ModelProfile = {
	family: "Unbekannte Familie",
	mission:
		"Du bist ein allgemeines Sprachmodell. Der Zuschnitt dieses Modells ist im System nicht hinterlegt.",
	strengths: [
		"allgemeine Textaufgaben: erklären, zusammenfassen, umformulieren",
		"Entwürfe, die anschliessend geprüft werden",
	],
	usage: [
		"Aufgabe, Kontext und gewünschte Ergebnisform ausdrücklich benennen.",
		"Ergebnisse der ersten Aufträge prüfen und dieses `plan.md` danach schärfen.",
	],
	limits: [
		"Bis das Profil geprüft ist: keine Aufträge, bei denen ein Fehler teuer wird.",
		"Keine Faktenaussage ohne Beleg.",
	],
	capabilities: [],
	settings: { temperature: 0.7, maxTokens: 4096 },
}

/* ------------------------------- Heuristiken --------------------------------- */

/**
 * Parameterzahl in Milliarden aus dem Namen — `8b`, `1.5b`, `8x7b` (→ 56),
 * `120b`. `undefined`, wenn der Name nichts hergibt (Cloud-Modelle).
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

/** Grobe Klasse nach Parameterzahl — bestimmt, wie viel man dem Modell zumutet. */
function sizeNote(params: number): { strength?: string; limit?: string } {
	if (params <= 4) {
		return {
			strength: `sehr klein (${params} Mrd. Parameter) — schnell und sparsam, gut für Routine und Vorfilter`,
			limit: "Aufträge klein schneiden: mehrstufige Analysen und lange Texte überfordern dieses Modell.",
		}
	}
	if (params <= 15) {
		return {
			strength: `mittlere Grösse (${params} Mrd. Parameter) — guter Kompromiss aus Tempo und Qualität`,
			limit: "Bei schwierigen Aufträgen die Antwort gegenprüfen oder ein grösseres Modell wählen.",
		}
	}
	if (params <= 40) {
		return {
			strength: `gross (${params} Mrd. Parameter) — belastbar auch bei anspruchsvollen Aufträgen`,
			limit: "Braucht viel Speicher; parallele Aufträge auf demselben Rechner meiden.",
		}
	}
	return {
		strength: `sehr gross (${params} Mrd. Parameter) — höchste Qualität dieses Rechners`,
		limit: "Langsam und speicherhungrig: nur für Aufträge, die es wirklich brauchen.",
	}
}

/** Quantisierung → was sie in der Praxis bedeutet. */
function quantizationLimit(quantization: string): string | undefined {
	const q = quantization.toLowerCase()
	if (/q2|q3|iq[123]/.test(q)) {
		return `Stark quantisiert (${quantization}): Ausgaben werden ungenauer — Zahlen, Namen und Code nachprüfen.`
	}
	if (/q4/.test(q)) {
		return `Quantisiert (${quantization}): guter Kompromiss, bei exakten Zahlen und Zitaten trotzdem nachprüfen.`
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

/**
 * Das Profil zu einem Modell: Familie über den Namen, danach ergänzt um das,
 * was Parameterzahl, Kontextfenster, Quantisierung und Preis verraten.
 *
 * Vom Provider gemeldete Fähigkeiten gewinnen immer — sie sind gemessen, das
 * Profil ist geraten.
 */
export function profileForModel(identity: ModelIdentity): ModelProfile {
	const haystack = `${identity.modelId} ${identity.displayName ?? ""}`.toLowerCase()
	const matched = MODEL_FAMILIES.find((rule) => rule.test.test(haystack))?.profile
	const base = matched ?? GENERIC_PROFILE

	const strengths = [...base.strengths]
	const limits = [...base.limits]
	let capabilities = [...base.capabilities]

	const params = parameterCount(haystack)
	if (params !== undefined) {
		const note = sizeNote(params)
		strengths.push(...(note.strength ? [note.strength] : []))
		limits.push(...(note.limit ? [note.limit] : []))
	}

	const ctx = identity.contextWindow
	if (ctx !== undefined && ctx > 0) {
		if (ctx >= 32768) {
			strengths.push(
				`grosses Kontextfenster (${Math.round(ctx / 1024)}k Token) — ganze Dateien und Dokumente am Stück`,
			)
			capabilities = withUnique(capabilities, "longform")
		} else if (ctx <= 8192) {
			limits.push(
				`Kleines Kontextfenster (${Math.round(ctx / 1024)}k Token): lange Eingaben vorher kürzen oder aufteilen.`,
			)
			capabilities = capabilities.filter((c) => c !== "longform")
		}
	}

	const quantLimit = identity.quantization ? quantizationLimit(identity.quantization) : undefined
	if (quantLimit) {
		limits.push(quantLimit)
	}

	const price = identity.pricePerMTok
	if (price && (price.in > 0 || price.out > 0)) {
		limits.push(
			`Kostet Geld (${price.in} $ ein / ${price.out} $ aus je Mio. Token): Kontext knapp halten, Routine lokal erledigen.`,
		)
	}

	// Gemessen schlägt geraten.
	if (identity.capabilities && identity.capabilities.length > 0) {
		capabilities = withUnique(capabilities, ...identity.capabilities)
	}

	return { ...base, strengths, limits, capabilities, settings: { ...base.settings } }
}

/* -------------------------------- Dokumente ---------------------------------- */

/** Kopfzeile mit den harten Fakten — steht im `plan.md` über dem Auftrag. */
function profileFacts(identity: ModelIdentity, profile: ModelProfile): string {
	const parts = [profile.family]
	const params = parameterCount(`${identity.modelId} ${identity.displayName ?? ""}`)
	if (params !== undefined) {
		parts.push(`${params} Mrd. Parameter`)
	}
	if (identity.contextWindow) {
		parts.push(`${Math.round(identity.contextWindow / 1024)}k Kontext`)
	}
	if (identity.quantization) {
		parts.push(identity.quantization)
	}
	if (identity.pricePerMTok && (identity.pricePerMTok.in > 0 || identity.pricePerMTok.out > 0)) {
		parts.push(`${identity.pricePerMTok.in}/${identity.pricePerMTok.out} $ je Mio. Token`)
	}
	return parts.join(" · ")
}

/**
 * `plan.md` einer LLM-Instanz — dieselbe Gliederung wie die Vorlage
 * (`defaultDoc`), aber ausgefüllt. `extractDirective` macht daraus die
 * verbindliche Arbeitsanweisung im System-Prompt.
 */
export function renderInstancePlan(identity: ModelIdentity, isoDate: string): string {
	const profile = profileForModel(identity)
	const name = identity.displayName || identity.modelId
	return [
		`# plan.md — ${name}`,
		"",
		`**Erstellt am:** ${isoDate.slice(0, 10)}`,
		"",
		`Profil: ${profileFacts(identity, profile)}`,
		"",
		"## 1. Auftrag",
		"",
		profile.mission,
		"",
		"Dafür wird dieses Modell gerufen:",
		"",
		...profile.strengths.map((s) => `- ${s}`),
		"",
		"## 2. Vorgehen",
		"",
		...profile.usage.map((s) => `- ${s}`),
		"",
		"## 3. Leitplanken",
		"",
		...profile.limits.map((s) => `- ${s}`),
		"",
	].join("\n")
}

/**
 * Die drei Startdokumente einer LLM-Instanz — befüllt statt Vorlage.
 * `changelog.md` hält fest, woher das Profil stammt: Es ist geraten, und wer
 * es später korrigiert, soll sehen, dass es niemand geprüft hat.
 */
export function instanceProfileDocs(identity: ModelIdentity, isoDate: string): Record<AgentDocKind, string> {
	const profile = profileForModel(identity)
	const name = identity.displayName || identity.modelId
	const day = isoDate.slice(0, 10)
	return {
		plan: renderInstancePlan(identity, isoDate),
		changelog: [
			`# changelog.md — ${name}`,
			"",
			"Änderungsprotokoll (neueste Einträge oben).",
			"",
			`- ${day} — Modell angelegt, Profil „${profile.family}" aus dem Modell-Katalog übernommen (ungeprüft)`,
			"",
		].join("\n"),
		init: renderInitDoc(profile.settings, name),
	}
}
