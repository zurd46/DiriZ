/**
 * M8 Agentik: Tests für den Tool-Call-Agent-Loop — Fake-Adapter statt HTTP.
 * Abgedeckt: Tool-Ausführung in der Sandbox, Ergebnis-Rückgabe an das Modell,
 * Schritt-Limit (Endlosschleifen-Schutz) und Event-/Delta-Kallbacks.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	ChatChunk,
	ChatRequest,
	DiscoveredModel,
	HealthStatus,
	LLMProvider,
	ProviderType,
} from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { runAgentLoop } from "../src/execution/agent.js"

type Behavior = "write-then-done" | "loop"

class ToolFakeAdapter implements LLMProvider {
	readonly label = "ToolFake"
	/** M8: Adapter unterstützt Tool-Calls. */
	readonly supportsTools = true
	requests: ChatRequest[] = []
	constructor(
		readonly id: string,
		readonly type: ProviderType,
		private behavior: Behavior,
	) {}
	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		this.requests.push(req)
		const hasToolResult = req.messages.some((m) => m.role === "tool")
		if (this.behavior === "loop" || !hasToolResult) {
			yield {
				type: "delta",
				text: this.behavior === "loop" ? "Ich rufe weiter an. " : "Ich schreibe die Datei. ",
			}
			yield {
				type: "tool_call",
				call: {
					id: `c${this.requests.length}`,
					name: "write_file",
					arguments: { path: "out/hello.txt", content: "hallo" },
				},
			}
		} else {
			yield { type: "delta", text: "Fertig!" }
		}
		yield { type: "usage", tokensIn: 5, tokensOut: 3 }
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}
}

describe("agent: Tool-Loop", () => {
	it("führt den Tool-Call aus, gibt das Ergebnis zurück und beendet sich", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "write-then-done")
		const deltas: string[] = []
		const toolCalls: { name: string; ok: boolean }[] = []

		const result = await runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Schreib eine Datei",
			baseDir,
			executionId: "e1",
			onDelta: (t) => deltas.push(t),
			emitToolCall: (d) => toolCalls.push({ name: d.name, ok: d.ok }),
			log: () => {},
		})

		expect(result.steps).toBe(2)
		expect(result.toolOps).toBe(1)
		expect(result.text).toContain("Fertig!")
		expect(deltas.join("")).toContain("Ich schreibe die Datei.")
		expect(toolCalls).toEqual([{ name: "write_file", ok: true }])

		// Die Datei wurde in der Sandbox geschrieben.
		const written = fs.readFileSync(path.join(baseDir, "out/hello.txt"), "utf8")
		expect(written).toBe("hallo")

		// Das Modell bekam das Tool-Ergebnis als `tool`-Message zurück.
		const secondRequest = adapter.requests[1]
		expect(secondRequest.messages.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0)).toBe(
			true,
		)
		const toolMsg = secondRequest.messages.find((m) => m.role === "tool")
		expect(toolMsg).toBeTruthy()
		if (toolMsg) {
			expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: true })
		}

		// Tool-Specs wurden mitgeschickt.
		expect(adapter.requests[0].tools?.map((t) => t.name)).toContain("write_file")
	})

	it("bricht bei Endlosschleifen am Schritt-Limit ab (mit Hinweis)", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-loop-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "loop")

		const result = await runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Endlos",
			baseDir,
			executionId: "e2",
			maxSteps: 3,
			onDelta: () => {},
			emitToolCall: () => {},
			log: () => {},
		})

		expect(result.steps).toBe(3)
		expect(result.toolOps).toBe(3)
		expect(adapter.requests).toHaveLength(3)
		expect(result.text).toContain("Schritt-Limit")
	})
})
