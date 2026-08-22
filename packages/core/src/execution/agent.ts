/**
 * Agent-Loop (M8, `01-plan.md` §v1.5): Das Modell arbeitet autonom mit den
 * Datei-Tools (`list_files`, `read_file`, `write_file`) in der Task-Sandbox.
 *
 * Ablauf pro Schritt: Streamen → Tool-Calls sammeln → ausführen (jeder wird
 * per Event + Log sichtbar) → Ergebnisse als `tool`-Messages zurückgeben →
 * weiter, bis das Modell ohne Calls antwortet oder das Schritt-Limit erreicht
 * ist. Reine Steuerung — Persistenz/Events bleiben beim Engine.
 */

import type { ChatMessage, LLMProvider, ModelSettings, ToolCallRequest } from "@diriz/shared"
import { executeTool, TOOL_SPECS } from "./tools.js"

/** Schutz vor Endlosschleifen: max. Modell-Schritte pro Execution. */
export const MAX_AGENT_STEPS = 8

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
	/** Tool-Operation melden (Event `tool.call`). */
	emitToolCall: (data: { name: string; argsSummary: string; ok: boolean; detail?: string }) => void
	log: LogFn
}

export interface AgentLoopResult {
	/** Letzter Assistenten-Text (die finale Antwort). */
	text: string
	steps: number
	toolOps: number
	tokensIn: number
	tokensOut: number
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
	const maxSteps = opts.maxSteps ?? MAX_AGENT_STEPS
	// Kurze Tool-Anleitung — lokale Modelle brauchen den Hinweis explizit.
	const toolHint =
		"Du kannst Dateien im Workspace mit den Tools list_files, read_file und write_file lesen und schreiben. " +
		"Nutze die Tools, um die Aufgabe zu erledigen; gib am Ende eine kurze Textantwort."
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
	let hitStepLimit = false

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
			messages.push({
				role: "tool",
				toolCallId: call.id,
				content: JSON.stringify(result),
			})
		}
		opts.log("info", "agent", `Schritt ${step}: ${calls.length} Tool-Operation(en) ausgeführt`)
		hitStepLimit = true
	}

	if (hitStepLimit && steps >= maxSteps) {
		text += `\n\n[Agentik: Schritt-Limit (${maxSteps}) erreicht — die Antwort kann unvollständig sein.]`
		opts.onDelta(`\n\n[Agentik: Schritt-Limit (${maxSteps}) erreicht — die Antwort kann unvollständig sein.]`)
	}

	return { text, steps, toolOps, tokensIn, tokensOut }
}
