/**
 * Agent-Loop (M8, `01-plan.md` §v1.5): Das Modell arbeitet autonom mit den
 * Datei-Tools (`list_files`, `read_file`, `write_file`) in der Task-Sandbox.
 *
 * Ablauf pro Schritt: Streamen → Tool-Calls sammeln → ausführen (jeder wird
 * per Event + Log sichtbar) → Ergebnisse als `tool`-Messages zurückgeben →
 * weiter, bis das Modell ohne Calls antwortet oder das Tool-Budget erschöpft
 * ist. Reine Steuerung — Persistenz/Events bleiben beim Engine.
 *
 * **Garantie: Es gibt immer eine Antwort.** Das Schritt-Limit begrenzt nur die
 * Tool-Nutzung, nie die Antwort. Läuft das Budget aus (oder liefert das Modell
 * gar keinen Text), folgt ein Abschluss-Schritt *ohne* Tools: Das Modell muss
 * die Aufgabe aus dem bereits Gesammelten fertig beantworten. Scheitert auch
 * das, fasst DiriZ den Arbeitsstand selbst zusammen — abgeschnittene oder
 * leere Antworten kann es damit nicht mehr geben.
 */

import type { ChatMessage, LLMProvider, ModelSettings, ToolCallRequest } from "@diriz/shared"
import {
	type CommandPolicy,
	executeTool,
	MUTATING_TOOLS,
	READING_TOOLS,
	TOOL_SPECS,
	type ToolOpResult,
	touchedPaths,
} from "./tools.js"

/**
 * Schutz vor Endlosschleifen: max. Modell-Schritte **mit Tools** pro Execution.
 * Begrenzt nur die Tool-Nutzung — die Antwort folgt danach garantiert.
 * Über `DIRIZ_AGENT_MAX_STEPS` anpassbar (z. B. für grosse Repositories).
 */
/**
 * Vorgabe für das Tool-Budget. **0 = unbegrenzt** — die Gesamtdauer ist die
 * Grenze, nicht eine geratene Schrittzahl. Über `DIRIZ_AGENT_STEPS` oder die
 * Einstellungen überschreibbar.
 */
export const MAX_AGENT_STEPS = readMaxStepsEnv() ?? 0

/**
 * So viele Schritte in Folge darf ein Schritt **ohne Fortschritt** bleiben,
 * bevor der Loop abbricht.
 *
 * Ohne Fortschritt heisst: Jede Operation dieses Schritts ist entweder
 * gescheitert **oder** war eine wortgleiche Wiederholung. Beobachtet wurde
 * genau das — ein Modell schrieb dieselbe Datei mit demselben Inhalt 51-mal,
 * über 20 Minuten, jedes Mal mit „ok" quittiert. Der Fehlschlag-Zähler allein
 * greift dort nicht: Erfolgreiches Nichtstun sieht für ihn aus wie Arbeit.
 *
 * Drei sind genug für einen Ausrutscher (ein zweiter Anlauf nach einer
 * Korrektur) und wenig genug, um eine Schleife zu stoppen.
 */
const MAX_FAILED_TOOL_STREAK = 3

/**
 * Nach so vielen Werkzeug-Operationen erinnert DiriZ das Modell an den Stand.
 *
 * Keine Grenze — eine Standmeldung. Sie kostet zwei Zeilen Kontext und hat in
 * den Läufen davor gefehlt, in denen ein Modell 274-mal las, ohne zu antworten.
 */
const REMINDER_EVERY_OPS = 50

/**
 * Ab wie viel belegtem Kontext ältere Tool-Ergebnisse eingedampft werden.
 *
 * Jeder Schritt schickt den gesamten bisherigen Verlauf erneut — und die
 * Verarbeitungszeit wächst mit ihm. Ein Lauf, der zehn Dateien gelesen hat,
 * trägt sie in jedem weiteren Schritt mit; irgendwann besteht der halbe
 * Kontext aus Material, das längst ausgewertet ist, und jeder Schritt dauert
 * länger als der vorige.
 */
const CONTEXT_TRIM_RATIO = 0.6

/** Zeichen je Token (grobe Schätzung, dieselbe wie im Routing). */
const CHARS_PER_TOKEN = 3.5

/** Wie viele der jüngsten Tool-Ergebnisse **immer** vollständig bleiben. */
const KEEP_RECENT_TOOL_RESULTS = 4

/**
 * Dampft alte Tool-Ergebnisse ein, wenn der Verlauf zu gross wird.
 *
 * Ersetzt wird nur der **Inhalt** alter `tool`-Nachrichten, nie die Struktur:
 * Jede Antwort bleibt an ihrem Aufruf hängen (sonst bricht das Format vieler
 * Backends), und die jüngsten Ergebnisse bleiben unangetastet — mit ihnen
 * arbeitet das Modell gerade.
 *
 * Rein und exportiert, damit die Grenze prüfbar ist.
 */
export function trimContext(
	messages: ChatMessage[],
	contextWindow: number | undefined,
): { messages: ChatMessage[]; trimmed: number } {
	if (!contextWindow || contextWindow <= 0) {
		return { messages, trimmed: 0 }
	}
	const used = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / CHARS_PER_TOKEN
	if (used < contextWindow * CONTEXT_TRIM_RATIO) {
		return { messages, trimmed: 0 }
	}

	const toolIndexes = messages
		.map((m, i) => (m.role === "tool" ? i : -1))
		.filter((i) => i >= 0)
		.slice(0, -KEEP_RECENT_TOOL_RESULTS)
	let trimmed = 0
	const out = messages.map((m, i) => {
		if (!toolIndexes.includes(i) || m.content.length < 400) {
			return m
		}
		trimmed++
		return {
			...m,
			content: JSON.stringify({
				ok: true,
				detail:
					`[Gekürzt, um Platz zu schaffen — ${m.content.length} Zeichen. Der Inhalt wurde bereits ` +
					"ausgewertet; lies die Datei erneut, falls du eine konkrete Stelle brauchst.]",
			}),
		}
	})
	return { messages: out, trimmed }
}

function readMaxStepsEnv(): number | undefined {
	const raw = Number.parseInt(process.env.DIRIZ_AGENT_MAX_STEPS ?? "", 10)
	return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/** Versuche für den Abschluss-Schritt, bevor DiriZ selbst zusammenfasst. */
const FINAL_ANSWER_ATTEMPTS = 2

type LogFn = (level: "info" | "warn" | "error", scope: string, msg: string) => void

export interface AgentLoopOptions {
	adapter: LLMProvider
	model: string
	settings?: ModelSettings
	systemPrompt?: string
	userPrompt: string
	/** Absoluter Pfad der Task-Sandbox (Workspace-Unterverzeichnis). */
	baseDir: string
	executionId: string
	signal?: AbortSignal
	maxSteps?: number
	/** Live-Delta an den Engine (Streaming + Persistenz). */
	onDelta: (text: string) => void
	/** Gedankengang eines Reasoning-Modells (`execution.reasoning`). */
	onReasoning?: (text: string) => void
	/**
	 * Wird vor jedem Modellaufruf gerufen — auch vor dem Abschluss-Schritt.
	 * Der Aufrufer kann damit seine Zeitüberwachung zurücksetzen: Jeder Schritt
	 * schickt den gesamten bisherigen Verlauf erneut, und dessen Verarbeitung
	 * dauert bei grossem Kontext Minuten, in denen nichts zurückkommt.
	 */
	onStepStart?: () => void
	/** Tool-Operation melden (Event `tool.call`). */
	emitToolCall: (data: { name: string; argsSummary: string; ok: boolean; detail?: string }) => void
	log: LogFn
	/** Kontextfenster des Modells — Grundlage fürs Eindampfen alter Ergebnisse. */
	contextWindow?: number
	/** Was `run_command` darf (Erlaubnisliste, Frist) — aus den Einstellungen. */
	commandPolicy?: CommandPolicy
	/**
	 * Freigegebene Werkzeuge laut `llm.md` des Modells. Leer/undefiniert = alle.
	 * Wer im Datenblatt `write_file` streicht, nimmt dem Modell das Schreiben —
	 * die Deklaration wirkt, sie ist keine Notiz.
	 */
	allowedTools?: string[]
}

export interface AgentLoopResult {
	/** Gesamter Assistenten-Text inkl. Abschlussantwort — nie leer. */
	text: string
	steps: number
	toolOps: number
	tokensIn: number
	tokensOut: number
	/** Tool-Budget war erschöpft, es folgte ein Abschluss-Schritt ohne Tools. */
	stepLimitReached: boolean
	/** Die finale Antwort stammt aus dem Abschluss-Schritt (statt aus dem Loop). */
	finalized: boolean
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
	// 0 (oder negativ) bedeutet unbegrenzt — dann bestimmt allein das
	// Gesamt-Timeout das Ende. Ein Tool-Budget, das mitten in der Arbeit
	// zuschlägt, kostet den Lauf mehr, als es je an Schutz bringt.
	// Werkzeug-Freigabe aus dem Datenblatt; ohne Angabe gilt der volle Satz.
	const tools =
		opts.allowedTools && opts.allowedTools.length > 0
			? TOOL_SPECS.filter((t) => opts.allowedTools?.includes(t.name))
			: TOOL_SPECS
	const toolNames = tools.map((t) => t.name)
	const requested = opts.maxSteps ?? MAX_AGENT_STEPS
	const maxSteps = requested > 0 ? requested : Number.POSITIVE_INFINITY
	const unlimited = !Number.isFinite(maxSteps)
	// Kurze Tool-Anleitung — lokale Modelle brauchen den Hinweis explizit.
	const darfAusführen = toolNames.includes("run_command")
	// Änderungen: `edit_file` statt `write_file`. Der Hinweis muss ausdrücklich
	// dastehen — ein Modell greift sonst zum vertrauteren „ganze Datei
	// schreiben" und löscht dabei alles, was es nicht mitgeschrieben hat.
	const darfÄndern = toolNames.includes("edit_file")
	const toolHint =
		`Du kannst im Workspace die Tools ${toolNames.join(", ")} nutzen. ` +
		(darfÄndern
			? "Zum **Ändern** bestehender Dateien nimm `edit_file` (Textstelle ersetzen) — `write_file` " +
				"überschreibt die ganze Datei und löscht alles, was du nicht mitschreibst; nimm es nur für " +
				"neue Dateien. `search_files` findet eine Stelle schneller, als sich durch die Dateien zu lesen. "
			: "") +
		(darfAusführen
			? // Mit Ausführung: Sagen, wie sie zu nutzen ist — und wo sie endet.
				"Mit `run_command` prüfst du deine Arbeit wirklich, statt sie zu vermuten: Schreib das Skript, " +
				"führ es aus, lies die Ausgabe. Es gibt **keine Shell** — `command` ist das Programm, `args` " +
				"seine Argumente; |, &&, ; und $() sind gewöhnliche Zeichen. Erlaubt sind Entwicklungswerkzeuge; " +
				"was nicht erlaubt ist, sagt dir die Fehlermeldung. Wiederhole einen Aufruf nicht, der schon " +
				"gescheitert ist. "
			: // Ohne Ausführung: Klar sagen, dass Warten auf ein Ergebnis nichts bringt.
				"Mehr gibt es nicht: Du kannst **keinen Code ausführen**, keine Tests laufen lassen und keine " +
				"Programmausgabe sehen. Ein Prüfskript zu schreiben und auf sein Ergebnis zu warten führt zu " +
				"nichts — beschreibe stattdessen, was zu prüfen ist. ") +
		"Nutze die Tools, um die Aufgabe zu erledigen; gib am Ende eine vollständige Textantwort. " +
		(unlimited
			? "Du hast kein Schritt-Limit — arbeite so gründlich, wie die Aufgabe es verlangt, " +
				"und vermeide es, dieselbe Datei mehrfach zu lesen."
			: `Dein Tool-Budget beträgt ${maxSteps} Schritte — plane sparsam und beantworte die Aufgabe, ` +
				"bevor es aufgebraucht ist.")
	const systemContent = opts.systemPrompt ? `${opts.systemPrompt}\n\n${toolHint}` : toolHint
	const messages: ChatMessage[] = [
		{ role: "system", content: systemContent },
		{ role: "user", content: opts.userPrompt },
	]

	let text = ""
	let steps = 0
	let toolOps = 0
	let tokensIn = 0
	let tokensOut = 0
	let stepLimitReached = false
	/** Kurzprotokoll der Tool-Operationen — Basis der Notfall-Zusammenfassung. */
	const toolTrail: string[] = []
	/**
	 * Schritte in Folge, in denen **jede** Tool-Operation gescheitert ist.
	 *
	 * Ohne Schritt-Limit (`maxSteps: 0`) läuft der Loop sonst endlos: Ein Modell,
	 * dessen Tool-Aufruf abgeschnitten ankommt (etwa weil `Max-Tokens` zu klein
	 * ist), schickt denselben kaputten Aufruf beliebig oft — beobachtet als
	 * „write_file → Ungültiger Pfad" über dutzende Schritte, ohne dass je
	 * etwas entsteht.
	 */
	let failedStreak = 0
	/**
	 * Fingerabdrücke aller bisher ausgeführten Aufrufe (Name + Argumente).
	 *
	 * Auch schreibende: Dieselbe Datei mit **demselben** Inhalt ein zweites Mal
	 * zu schreiben ändert nichts — es ist der Beweis, dass das Modell im Kreis
	 * läuft, nicht ein Arbeitsschritt.
	 */
	const gesehen = new Set<string>()
	/**
	 * Wurde seit dem letzten Befehl etwas geschrieben?
	 *
	 * Erst damit lässt sich „prüft seine Änderung" von „läuft im Kreis"
	 * unterscheiden: Derselbe `npm test` nach einer Bearbeitung ist der Sinn des
	 * Werkzeugs; derselbe `npm test` ohne jede Änderung dazwischen ist eine
	 * Schleife.
	 */
	let seitLetztemBefehlGeschrieben = true
	/** Werkzeug-Operationen insgesamt — Grundlage der Standmeldung. */
	let operationen = 0
	let zuletztErinnert = 0
	/**
	 * Ergebnisse bereits ausgeführter Lese-Aufrufe.
	 *
	 * Modelle lesen dieselbe Datei gern mehrfach — jedes Mal wandert ihr voller
	 * Inhalt erneut in den Kontext, jeder weitere Schritt wird dadurch langsamer,
	 * und irgendwann besteht der halbe Kontext aus Wiederholungen. Ein kurzer
	 * Hinweis statt des zweiten Abzugs hält den Kontext klein und den Lauf
	 * schnell. Schreibende Aufrufe sind ausgenommen — sie müssen immer laufen.
	 */
	const gelesen = new Map<string, ToolOpResult>()

	for (let step = 1; step <= maxSteps; step++) {
		steps = step
		if (opts.signal?.aborted) {
			throw new Error("Abgebrochen")
		}

		// Vor jedem Aufruf: Passt der Verlauf noch bequem ins Fenster? Sonst
		// werden alte Tool-Ergebnisse eingedampft — sie sind ausgewertet, ihr
		// voller Text kostet ab jetzt nur noch Zeit.
		const gekürzt = trimContext(messages, opts.contextWindow)
		if (gekürzt.trimmed > 0) {
			messages.length = 0
			messages.push(...gekürzt.messages)
			opts.log("info", "agent", `Kontext eingedampft: ${gekürzt.trimmed} alte Tool-Ergebnis(se) gekürzt`)
		}
		opts.onStepStart?.()
		const stream = opts.adapter.chat({
			messages,
			model: opts.model,
			settings: opts.settings,
			tools,
			signal: opts.signal,
		})

		let stepText = ""
		const calls: ToolCallRequest[] = []
		for await (const chunk of stream) {
			if (opts.signal?.aborted) {
				throw new Error("Abgebrochen")
			}
			if (chunk.type === "delta") {
				stepText += chunk.text
				opts.onDelta(chunk.text)
			} else if (chunk.type === "reasoning") {
				opts.onReasoning?.(chunk.text)
			} else if (chunk.type === "tool_call") {
				calls.push(chunk.call)
			} else if (chunk.type === "usage") {
				tokensIn += chunk.tokensIn
				tokensOut += chunk.tokensOut
			}
		}
		text = stepText

		if (calls.length === 0) {
			break // finale Antwort ohne Tool-Calls
		}

		// Tools ausführen und die Ergebnisse dem Modell zurückgeben.
		messages.push({ role: "assistant", content: stepText, toolCalls: calls })
		let failedInStep = 0
		/** Operationen dieses Schritts, die nichts bewegt haben. */
		let ohneFortschritt = 0
		for (const call of calls) {
			const key = `${call.name}:${JSON.stringify(call.arguments ?? {})}`
			// **Nur Lesevorgänge** werden aus dem Verlauf beantwortet. Ein Befehl
			// ist eine Handlung, keine Auskunft: `npm test` nach einer Änderung
			// erneut zu starten ist genau der Sinn der Sache — ihn mit „steht
			// schon oben" abzuspeisen macht das Werkzeug wertlos. Erkannt wurde
			// das an einem Lauf, den DiriZ nach drei solchen Antworten selbst
			// als „ohne Fortschritt" abbrach.
			const istLesen = READING_TOOLS.has(call.name)
			const wiederholung = istLesen ? gelesen.get(key) : undefined
			// Wortgleicher Schreibvorgang: nicht noch einmal ausführen, sondern
			// sagen, dass er nichts ändert. Sonst quittiert DiriZ Stillstand mit
			// „ok" und das Modell hat keinen Grund, damit aufzuhören.
			const nochmalGeschrieben = call.name === "write_file" && gesehen.has(key)
			const result = nochmalGeschrieben
				? {
						ok: false,
						detail:
							"Diese Datei hast du bereits mit exakt diesem Inhalt geschrieben — der Aufruf ändert " +
							"nichts. Wenn du nicht weiterkommst, beschreibe das Ergebnis in Worten und beende die " +
							"Aufgabe.",
					}
				: wiederholung
					? {
							ok: true,
							detail:
								`Bereits in einem früheren Schritt gelesen — Inhalt steht oben im Verlauf. ` +
								`Lies nicht erneut, sondern arbeite damit weiter. (${wiederholung.detail.slice(0, 120)})`,
						}
					: await executeTool(
							opts.baseDir,
							call,
							opts.emitToolCall,
							opts.log,
							opts.commandPolicy,
							opts.signal,
						)
			// Ein Befehl, der **wortgleich wiederholt** wird, ohne dass seither
			// etwas geschrieben wurde, bewegt nichts — dann ist es eine Schleife.
			// Nach einer Änderung ist derselbe Befehl dagegen echte Arbeit.
			const wirkungsloserBefehl =
				call.name === "run_command" && gesehen.has(key) && !seitLetztemBefehlGeschrieben
			if (nochmalGeschrieben || wiederholung || wirkungsloserBefehl) {
				ohneFortschritt++
			}
			if (MUTATING_TOOLS.has(call.name) && !nochmalGeschrieben) {
				seitLetztemBefehlGeschrieben = true
			}
			if (call.name === "run_command") {
				seitLetztemBefehlGeschrieben = false
			}
			// **Nach einer Änderung ist der alte Inhalt falsch.**
			//
			// Ohne dieses Verwerfen bekäme ein Modell, das eine Datei ändert und
			// danach noch einmal liest, den Stand von **vorher** — mit dem
			// Hinweis, es stehe ja schon oben im Verlauf. Es würde also die
			// eigene Änderung nicht sehen und sie für gescheitert halten. Mit
			// `edit_file` ist genau diese Reihenfolge (lesen → ändern → prüfen)
			// der Normalfall, deshalb muss der Zwischenspeicher hier weichen.
			if (result.ok && MUTATING_TOOLS.has(call.name)) {
				const beruehrt = touchedPaths(call)
				for (const [k] of gelesen) {
					if (beruehrt === undefined || k.startsWith("list_files:") || beruehrt.some((b) => k.includes(b))) {
						gelesen.delete(k)
					}
				}
			}
			// Ein Befehl kann alles verändert haben — Tests schreiben Dateien,
			// Generatoren erzeugen Code. Danach gilt kein gelesener Stand mehr.
			if (call.name === "run_command") {
				gelesen.clear()
			}
			gesehen.add(key)
			if (istLesen && !wiederholung && result.ok) {
				gelesen.set(key, result)
			}
			toolOps++
			if (!result.ok) {
				failedInStep++
			}
			toolTrail.push(
				`${call.name}(${summarizeArgs(call)}) → ${result.ok ? "ok" : `Fehler: ${result.detail}`}`,
			)
			messages.push({
				role: "tool",
				toolCallId: call.id,
				content: JSON.stringify(result),
			})
		}
		opts.log("info", "agent", `Schritt ${step}: ${calls.length} Tool-Operation(en) ausgeführt`)

		// Erinnerung statt Grenze.
		//
		// Beobachtet: eine Kettenstufe mit 274 Werkzeug-Operationen — das Modell
		// las weiter und weiter, ohne je zu antworten. Ein Deckel wäre die
		// falsche Antwort (manche Aufgaben brauchen wirklich hundert Schritte);
		// gefehlt hat der Blick auf die Uhr. Den liefert DiriZ jetzt nach: alle
		// 50 Operationen eine sachliche Standmeldung, ohne etwas zu erzwingen.
		operationen += calls.length
		if (operationen - zuletztErinnert >= REMINDER_EVERY_OPS) {
			zuletztErinnert = operationen
			messages.push({
				role: "user",
				content:
					`[DiriZ: Du hast bisher ${operationen} Werkzeug-Operationen ausgeführt. Das ist erlaubt — ` +
					"es gibt keine Obergrenze. Prüfe aber kurz: Hast du genug für eine Antwort? Wenn ja, " +
					"antworte jetzt, statt weiterzusuchen. Wenn nein, nenne im nächsten Schritt, was dir " +
					"konkret noch fehlt.]",
			})
			opts.log("info", "agent", `${operationen} Tool-Operationen — Standmeldung an das Modell`)
		}

		// Reissleine: Wenn mehrere Schritte hintereinander ausschliesslich
		// fehlschlagen, kommt das Modell aus eigener Kraft nicht mehr heraus.
		// Dann lieber sauber abbrechen und mit dem Erreichten antworten, als
		// stundenlang denselben Fehler zu wiederholen.
		failedStreak = failedInStep + ohneFortschritt >= calls.length ? failedStreak + 1 : 0
		if (failedStreak >= MAX_FAILED_TOOL_STREAK) {
			opts.log(
				"warn",
				"agent",
				`${failedStreak} Schritte in Folge ohne Fortschritt — Loop beendet (gescheiterte oder ` +
					"wortgleich wiederholte Operationen).",
			)
			opts.onDelta(
				`\n\n[Agentik: ${failedStreak} Schritte in Folge ohne Fortschritt — abgebrochen. ` +
					"Das Modell hat dieselbe Operation wiederholt, ohne etwas zu verändern.]\n\n",
			)
			stepLimitReached = true
			break
		}

		if (!unlimited && step === maxSteps) {
			stepLimitReached = true
		}
	}

	/* --------------------- Abschluss-Schritt (ohne Tools) -------------------- */
	// Nur das Tool-Budget ist begrenzt — die Antwort nie. Wenn das Modell am
	// Limit noch mitten in der Arbeit war oder gar keinen Text geliefert hat,
	// bekommt es genau einen tool-freien Schritt, um vollständig zu antworten.
	let finalized = false
	const needsFinal = stepLimitReached || text.trim() === ""

	if (needsFinal && !opts.signal?.aborted) {
		if (stepLimitReached) {
			// Bei unbegrenztem Budget steht hier keine Zahl: Der Loop wurde von
			// der Reissleine beendet, nicht vom Budget — „Infinity Schritte
			// aufgebraucht" ist ein durchgereichter Rechenwert, keine Auskunft.
			const grund = unlimited ? "Die Arbeit wurde beendet" : `Tool-Budget (${maxSteps} Schritte) aufgebraucht`
			opts.onDelta(
				`\n\n[Agentik: ${grund} — die Antwort wird jetzt aus den gesammelten Daten vollständig fertiggestellt.]\n\n`,
			)
			opts.log("warn", "agent", `${grund} — Abschluss-Schritt ohne Tools`)
		} else {
			opts.log("warn", "agent", "Keine Textantwort im Loop — Abschluss-Schritt ohne Tools")
		}

		messages.push({ role: "assistant", content: text })
		messages.push({
			role: "user",
			content: stepLimitReached
				? `${unlimited ? "Die Werkzeug-Arbeit ist beendet" : `Dein Tool-Budget von ${maxSteps} Schritten ist aufgebraucht`}. Beantworte die Aufgabe jetzt ` +
					"vollständig und abschliessend, ausschliesslich auf Basis der bereits gesammelten " +
					"Informationen. Keine weiteren Tool-Aufrufe — sie werden nicht mehr ausgeführt. " +
					"Nenne die konkreten Ergebnisse (Dateien, Fundstellen, Diagnose, Lösung). Falls etwas " +
					"offen bleiben musste, sage klar, was fehlt und welche nächsten Schritte nötig sind. " +
					"Brich nicht mitten im Text ab."
				: "Fasse dein Ergebnis jetzt als vollständige Textantwort zusammen. Keine Tool-Aufrufe.",
		})

		// **Ohne Werkzeug-Rollen.** Der Abschluss-Schritt schickt bewusst keine
		// Werkzeug-Definitionen mit — ein Verlauf, der trotzdem `tool_calls`
		// enthält, bringt die Vorlagen-Engine mancher Server zum Absturz:
		// LM Studio antwortet dann mit HTTP 500 und einer HTML-Fehlerseite, und
		// der ganze Lauf ist verloren. Nachgewiesen in einem Kettenlauf, bei dem
		// genau diese Anfrage dreimal in Folge scheiterte.
		const final = await requestFinalAnswer(opts, flattenToolHistory(messages))
		tokensIn += final.tokensIn
		tokensOut += final.tokensOut
		if (final.text.trim() !== "") {
			text = text.trim() === "" ? final.text : `${text}\n\n${final.text}`
			finalized = true
		} else {
			// Auch das Modell schweigt: DiriZ fasst den Arbeitsstand selbst
			// zusammen, damit nie eine leere Antwort zurückbleibt.
			const fallback = composeFallback(toolTrail, maxSteps, final.error)
			opts.onDelta(fallback)
			text = `${text}${fallback}`
			opts.log("warn", "agent", "Abschluss-Schritt lieferte keinen Text — DiriZ-Zusammenfassung eingesetzt")
		}
	}

	return { text, steps, toolOps, tokensIn, tokensOut, stepLimitReached, finalized }
}

/**
 * Macht aus einem Werkzeug-Verlauf einen reinen Textverlauf.
 *
 * Für den Abschluss-Schritt werden keine Werkzeug-Definitionen mitgeschickt —
 * dann dürfen auch keine `assistant`-Nachrichten mit `tool_calls` und keine
 * `tool`-Antworten mehr darin stehen. Server rendern den Verlauf über eine
 * Chat-Vorlage; findet die einen Werkzeug-Aufruf ohne zugehörige Definition,
 * bricht sie ab — LM Studio quittiert das mit HTTP 500 und einer
 * HTML-Fehlerseite, und die gesamte Arbeit des Laufs ist verloren.
 *
 * Was das Modell getan hat, bleibt erhalten: Jeder Aufruf wird zu einer Zeile
 * im Klartext. Leere `assistant`-Nachrichten fallen weg — auch die sind für
 * manche Vorlagen ein Stolperstein.
 */
export function flattenToolHistory(messages: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = []
	for (const m of messages) {
		if (m.role === "assistant" && m.toolCalls?.length) {
			const zeilen = m.toolCalls.map((c) => `[Werkzeug: ${c.name}(${summarizeArgs(c)})]`)
			out.push({ role: "assistant", content: [m.content?.trim(), ...zeilen].filter(Boolean).join("\n") })
			continue
		}
		if (m.role === "tool") {
			// Das Ergebnis gehört zum Verlauf — aber als Text, nicht als Rolle.
			const detail = ((): string => {
				try {
					const parsed = JSON.parse(m.content) as { ok?: boolean; detail?: string }
					return `${parsed.ok === false ? "Fehler" : "Ergebnis"}: ${parsed.detail ?? m.content}`
				} catch {
					return m.content
				}
			})()
			out.push({ role: "assistant", content: `[${detail.slice(0, 2000)}]` })
			continue
		}
		if (m.role === "assistant" && !m.content?.trim()) {
			continue
		}
		out.push(m)
	}
	return out
}

/** Argumente eines Tool-Calls knapp für das Protokoll darstellen. */
function summarizeArgs(call: ToolCallRequest): string {
	const args = call.arguments as Record<string, unknown> | undefined
	const path = args && typeof args.path === "string" ? args.path : ""
	return path || "—"
}

/**
 * Ein Modell-Schritt **ohne** Tool-Specs: Das Modell kann keine weiteren Calls
 * absetzen und muss antworten. Tool-Call-Chunks werden ignoriert (manche
 * Backends senden sie trotzdem). Fehler brechen nichts ab — der Aufrufer
 * fängt sie mit einer eigenen Zusammenfassung auf.
 */
async function requestFinalAnswer(
	opts: AgentLoopOptions,
	messages: ChatMessage[],
): Promise<{ text: string; tokensIn: number; tokensOut: number; error?: string }> {
	let tokensIn = 0
	let tokensOut = 0
	let lastError: string | undefined

	for (let attempt = 1; attempt <= FINAL_ANSWER_ATTEMPTS; attempt++) {
		if (opts.signal?.aborted) {
			break
		}
		let answer = ""
		try {
			opts.onStepStart?.()
			const stream = opts.adapter.chat({
				messages,
				model: opts.model,
				settings: opts.settings,
				signal: opts.signal,
			})
			for await (const chunk of stream) {
				if (opts.signal?.aborted) {
					throw new Error("Abgebrochen")
				}
				if (chunk.type === "delta") {
					answer += chunk.text
					opts.onDelta(chunk.text)
				} else if (chunk.type === "reasoning") {
					opts.onReasoning?.(chunk.text)
				} else if (chunk.type === "usage") {
					tokensIn += chunk.tokensIn
					tokensOut += chunk.tokensOut
				}
			}
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e)
			opts.log("warn", "agent", `Abschluss-Schritt fehlgeschlagen (Versuch ${attempt}): ${lastError}`)
			if (opts.signal?.aborted) {
				break
			}
			continue
		}
		if (answer.trim() !== "") {
			return { text: answer, tokensIn, tokensOut }
		}
		lastError = lastError ?? "leere Antwort"
	}

	return { text: "", tokensIn, tokensOut, error: lastError }
}

/**
 * Zeichnet den Werkzeug-Aufruf als Code aus, den Fehlertext dahinter nicht.
 *
 * Der Aufruf enthält Unterstriche und Pfade (die Markdown verstümmelt), der
 * Fehlertext ganze Sätze (die als Code unlesbar wären).
 */
function alsCode(entry: string): string {
	const pfeil = entry.indexOf(" → ")
	if (pfeil === -1) {
		return `\`${entry.replaceAll("`", "'")}\``
	}
	const aufruf = entry.slice(0, pfeil).replaceAll("`", "'")
	return `\`${aufruf}\`${entry.slice(pfeil)}`
}

/** Letzte Rettung: Arbeitsstand aus dem Tool-Protokoll, statt einer leeren Antwort. */
function composeFallback(toolTrail: string[], maxSteps: number, error?: string): string {
	// „Infinity Tool-Schritte" ist keine Auskunft, sondern ein durchgereichter
	// Rechenwert — hier steht, was gemeint ist.
	const budget = Number.isFinite(maxSteps) ? `${maxSteps} Tool-Schritten` : "unbegrenzt vielen Tool-Schritten"
	const lines = [
		`\n\n[Agentik: Das Modell hat nach ${budget} keine Abschlussantwort geliefert${
			error ? ` (${error})` : ""
		}. Arbeitsstand:]`,
	]
	if (toolTrail.length === 0) {
		lines.push("- Es wurden keine Tool-Operationen ausgeführt.")
	} else {
		const shown = toolTrail.slice(-20)
		if (toolTrail.length > shown.length) {
			lines.push(`- … ${toolTrail.length - shown.length} weitere Operation(en) davor`)
		}
		for (const entry of shown) {
			// **Als Code auszeichnen.** Der Arbeitsstand wird als Markdown
			// dargestellt, und dort sind Unterstriche Kursiv-Zeichen: Aus
			// `write_file(/tmp/replace_clean.py)` wurde in der Oberfläche
			// „writefile(/tmp/replaceclean.py)" — ein Werkzeugname, den es nicht
			// gibt, und ein Pfad, der nie geschrieben wurde. Wer damit
			// Fehlersuche betreibt, sucht am falschen Ort.
			lines.push(`- ${alsCode(entry)}`)
		}
	}
	lines.push(
		"Nächster Schritt: Task mit dem bisherigen Stand erneut starten oder das Tool-Budget erhöhen (`maxSteps`).",
	)
	return `${lines.join("\n")}\n`
}
