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
import { executeTool, TOOL_SPECS } from "./tools.js"

/** Schutz vor Endlosschleifen: max. Modell-Schritte **mit Tools** pro Execution. */
export const MAX_AGENT_STEPS = 24

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
	/** Tool-Operation melden (Event `tool.call`). */
	emitToolCall: (data: { name: string; argsSummary: string; ok: boolean; detail?: string }) => void
	log: LogFn
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
	const maxSteps = Math.max(1, opts.maxSteps ?? MAX_AGENT_STEPS)
	// Kurze Tool-Anleitung — lokale Modelle brauchen den Hinweis explizit.
	const toolHint =
		"Du kannst Dateien im Workspace mit den Tools list_files, read_file und write_file lesen und schreiben. " +
		"Nutze die Tools, um die Aufgabe zu erledigen; gib am Ende eine vollständige Textantwort. " +
		`Dein Tool-Budget beträgt ${maxSteps} Schritte — plane sparsam und beantworte die Aufgabe, ` +
		"bevor es aufgebraucht ist."
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

	for (let step = 1; step <= maxSteps; step++) {
		steps = step
		if (opts.signal?.aborted) {
			throw new Error("Abgebrochen")
		}

		const stream = opts.adapter.chat({
			messages,
			model: opts.model,
			settings: opts.settings,
			tools: TOOL_SPECS,
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
		for (const call of calls) {
			const result = executeTool(opts.baseDir, call, opts.emitToolCall, opts.log)
			toolOps++
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
		if (step === maxSteps) {
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
			emit(
				opts,
				`\n\n[Agentik: Tool-Budget (${maxSteps} Schritte) aufgebraucht — die Antwort wird jetzt aus den gesammelten Daten vollständig fertiggestellt.]\n\n`,
			)
			opts.log("warn", "agent", `Tool-Budget (${maxSteps}) erschöpft — Abschluss-Schritt ohne Tools`)
		} else {
			opts.log("warn", "agent", "Keine Textantwort im Loop — Abschluss-Schritt ohne Tools")
		}

		messages.push({ role: "assistant", content: text })
		messages.push({
			role: "user",
			content: stepLimitReached
				? `Dein Tool-Budget von ${maxSteps} Schritten ist aufgebraucht. Beantworte die Aufgabe jetzt ` +
					"vollständig und abschliessend, ausschliesslich auf Basis der bereits gesammelten " +
					"Informationen. Keine weiteren Tool-Aufrufe — sie werden nicht mehr ausgeführt. " +
					"Nenne die konkreten Ergebnisse (Dateien, Fundstellen, Diagnose, Lösung). Falls etwas " +
					"offen bleiben musste, sage klar, was fehlt und welche nächsten Schritte nötig sind. " +
					"Brich nicht mitten im Text ab."
				: "Fasse dein Ergebnis jetzt als vollständige Textantwort zusammen. Keine Tool-Aufrufe.",
		})

		const final = await requestFinalAnswer(opts, messages)
		tokensIn += final.tokensIn
		tokensOut += final.tokensOut
		if (final.text.trim() !== "") {
			text = text.trim() === "" ? final.text : `${text}\n\n${final.text}`
			finalized = true
		} else {
			// Auch das Modell schweigt: DiriZ fasst den Arbeitsstand selbst
			// zusammen, damit nie eine leere Antwort zurückbleibt.
			const fallback = composeFallback(toolTrail, maxSteps, final.error)
			emit(opts, fallback)
			text = `${text}${fallback}`
			opts.log("warn", "agent", "Abschluss-Schritt lieferte keinen Text — DiriZ-Zusammenfassung eingesetzt")
		}
	}

	return { text, steps, toolOps, tokensIn, tokensOut, stepLimitReached, finalized }
}

/** Delta an den Stream geben und für das Ergebnis merken. */
function emit(opts: AgentLoopOptions, chunk: string): void {
	opts.onDelta(chunk)
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

/** Letzte Rettung: Arbeitsstand aus dem Tool-Protokoll, statt einer leeren Antwort. */
function composeFallback(toolTrail: string[], maxSteps: number, error?: string): string {
	const lines = [
		`\n\n[Agentik: Das Modell hat nach ${maxSteps} Tool-Schritten keine Abschlussantwort geliefert${
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
			lines.push(`- ${entry}`)
		}
	}
	lines.push(
		"Nächster Schritt: Task mit dem bisherigen Stand erneut starten oder das Tool-Budget erhöhen (`maxSteps`).",
	)
	return `${lines.join("\n")}\n`
}
