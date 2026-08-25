/**
 * M8 Agentik: Tests für den Tool-Call-Agent-Loop — Fake-Adapter statt HTTP.
 * Abgedeckt: Tool-Ausführung in der Sandbox, Ergebnis-Rückgabe an das Modell,
 * Schritt-Limit (Endlosschleifen-Schutz), der garantierte Abschluss-Schritt
 * (die Antwort ist nie abgeschnitten oder leer) und Event-/Delta-Kallbacks.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	ChatChunk,
	ChatMessage,
	ChatRequest,
	DiscoveredModel,
	HealthStatus,
	LLMProvider,
	ProviderType,
} from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { runAgentLoop, trimContext } from "../src/execution/agent.js"

type Behavior =
	| "write-then-done"
	| "loop"
	| "stumm"
	| "kaputt"
	| "doppelt"
	| "schreibschleife"
	| "befehl-nach-änderung"

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
		// Ohne Tool-Specs kann das Backend keine Calls absetzen — der
		// Abschluss-Schritt des Loops sieht genau so aus.
		if (!req.tools) {
			if (this.behavior !== "stumm") {
				yield { type: "delta", text: "Abschluss: Ich habe out/hello.txt geschrieben." }
			}
			yield { type: "usage", tokensIn: 4, tokensOut: 2 }
			yield { type: "done" }
			return
		}
		if (this.behavior === "befehl-nach-änderung") {
			// Schreibt, prüft, schreibt, prüft — echte Arbeit, auch wenn der Befehl
			// jedes Mal derselbe ist.
			const n = this.requests.length
			yield {
				type: "tool_call",
				call:
					n % 2 === 1
						? {
								id: `w${n}`,
								name: "write_file",
								arguments: { path: "code.js", content: `// Fassung ${n}` },
							}
						: { id: `r${n}`, name: "run_command", arguments: { command: "node", args: ["-e", "0"] } },
			}
			yield { type: "usage", tokensIn: 2, tokensOut: 1 }
			yield { type: "done" }
			return
		}
		if (this.behavior === "schreibschleife") {
			// Schreibt immer wieder dieselbe Datei mit demselben Inhalt — genau
			// das Muster, das 51-mal in Folge beobachtet wurde.
			yield {
				type: "tool_call",
				call: {
					id: `c${this.requests.length}`,
					name: "write_file",
					arguments: { path: "check.mjs", content: "console.log(1)" },
				},
			}
			yield { type: "usage", tokensIn: 2, tokensOut: 1 }
			yield { type: "done" }
			return
		}
		if (this.behavior === "doppelt") {
			// Ruft immer wieder exakt denselben Lese-Aufruf auf.
			yield {
				type: "tool_call",
				call: { id: `c${this.requests.length}`, name: "read_file", arguments: { path: "a.txt" } },
			}
			yield { type: "usage", tokensIn: 2, tokensOut: 1 }
			yield { type: "done" }
			return
		}
		if (this.behavior === "kaputt") {
			// Abgeschnittener Tool-Aufruf: leerer Pfad — genau das Bild, das ein
			// zu kleines `Max-Tokens` erzeugt. Das Modell wiederholt ihn endlos.
			yield { type: "delta", text: "Ich schreibe gleich. " }
			yield {
				type: "tool_call",
				call: { id: `c${this.requests.length}`, name: "write_file", arguments: { path: "", content: "x" } },
			}
			yield { type: "usage", tokensIn: 5, tokensOut: 3 }
			yield { type: "done" }
			return
		}
		if (this.behavior === "stumm") {
			yield {
				type: "tool_call",
				call: {
					id: `c${this.requests.length}`,
					name: "read_file",
					arguments: { path: "fehlt.txt" },
				},
			}
			yield { type: "usage", tokensIn: 5, tokensOut: 3 }
			yield { type: "done" }
			return
		}
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
					arguments:
						this.behavior === "loop"
							? // Jeder Schritt schreibt etwas **Neues** — sonst wäre es keine
								// Arbeit, sondern die Schleife, die die Reissleine stoppt.
								{ path: `out/hello-${this.requests.length}.txt`, content: `hallo ${this.requests.length}` }
							: { path: "out/hello.txt", content: "hallo" },
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

	it("meldet jeden Schritt an, damit die Zeitüberwachung neu ansetzt", async () => {
		// Jeder Schritt schickt den ganzen Verlauf erneut; dessen Verarbeitung
		// dauert bei grossem Kontext Minuten. Ohne dieses Signal schlug die
		// strenge Chunk-Frist zu und verwarf die gesamte Arbeit.
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-steps-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "write-then-done")
		let starts = 0

		const result = await runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Schreib eine Datei",
			baseDir,
			executionId: "e-steps",
			onDelta: () => {},
			onStepStart: () => {
				starts++
			},
			emitToolCall: () => {},
			log: () => {},
		})

		expect(starts).toBe(result.steps)
	})

	it("liest dieselbe Datei nicht zweimal, sondern verweist auf den Verlauf", async () => {
		// Jede Wiederholung schöbe den vollen Dateiinhalt erneut in den Kontext
		// — und macht jeden weiteren Schritt langsamer.
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-dedup-"))
		fs.writeFileSync(path.join(baseDir, "a.txt"), "Inhalt")
		const adapter = new ToolFakeAdapter("fake", "ollama", "doppelt")
		const ops: { name: string; ok: boolean }[] = []

		await runAgentLoop({
			maxSteps: 3,
			adapter,
			model: "m1",
			userPrompt: "Lies zweimal",
			baseDir,
			executionId: "e-dedup",
			onDelta: () => {},
			emitToolCall: (d) => ops.push({ name: d.name, ok: d.ok }),
			log: () => {},
		})

		// Der zweite Aufruf wird beantwortet, aber nicht mehr ausgeführt:
		// Deshalb meldet nur der erste eine echte Tool-Operation.
		expect(ops.filter((o) => o.name === "read_file")).toHaveLength(1)
	})

	it("lässt denselben Befehl nach jeder Änderung erneut zu — das ist der Sinn", async () => {
		// Schreiben → prüfen → schreiben → prüfen ist Arbeit, keine Schleife.
		// Zuvor wurde ein wiederholter Befehl wie ein Lesevorgang aus dem Verlauf
		// beantwortet und der Lauf nach drei „Wiederholungen" abgebrochen.
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-pruefen-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "befehl-nach-änderung")
		const ops: { name: string; ok: boolean }[] = []

		const result = await runAgentLoop({
			maxSteps: 8,
			adapter,
			model: "m1",
			userPrompt: "Bau und prüfe",
			baseDir,
			executionId: "e-pruefen",
			onDelta: () => {},
			emitToolCall: (d) => ops.push({ name: d.name, ok: d.ok }),
			log: () => {},
		})

		// Der Lauf geht bis zum Budget durch, statt nach drei Schritten
		// abgewürgt zu werden — und jeder Befehl wird wirklich ausgeführt.
		expect(result.steps).toBe(8)
		expect(ops.filter((o) => o.name === "run_command").length).toBeGreaterThanOrEqual(3)
	})

	it("bricht ab, wenn dieselbe Datei immer wieder identisch geschrieben wird", async () => {
		// Erfolgreiches Nichtstun ist keine Arbeit: Der Fehlschlag-Zähler allein
		// greift hier nicht, weil jeder Schreibvorgang mit „ok" quittiert wird.
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-schleife-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "schreibschleife")
		const ops: { name: string; ok: boolean }[] = []

		const result = await runAgentLoop({
			maxSteps: 0, // unbegrenzt — nur die Reissleine kann hier stoppen
			adapter,
			model: "m1",
			userPrompt: "Schreib und prüfe",
			baseDir,
			executionId: "e-schleife",
			onDelta: () => {},
			emitToolCall: (d) => ops.push({ name: d.name, ok: d.ok }),
			log: () => {},
		})

		// Einmal geschrieben, dann drei Wiederholungen ohne Fortschritt → Schluss.
		expect(result.steps).toBeLessThanOrEqual(5)
		expect(ops.filter((o) => o.name === "write_file")).toHaveLength(1)
		expect(result.text.trim()).not.toBe("")
	})

	it("bricht ab, wenn mehrere Schritte in Folge nur fehlschlagen (kein Einfrieren)", async () => {
		// Ohne Reissleine liefe das ohne Schritt-Limit endlos: Der abgeschnittene
		// Aufruf scheitert, das Modell schickt ihn erneut — beobachtet als
		// „write_file → Ungültiger Pfad" über dutzende Schritte.
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-kaputt-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "kaputt")
		const toolCalls: { name: string; ok: boolean }[] = []

		const result = await runAgentLoop({
			maxSteps: 0, // unbegrenzt — nur die Reissleine kann hier stoppen
			adapter,
			model: "m1",
			userPrompt: "Schreib etwas",
			baseDir,
			executionId: "e-kaputt",
			onDelta: () => {},
			emitToolCall: (d) => toolCalls.push({ name: d.name, ok: d.ok }),
			log: () => {},
		})

		expect(result.steps).toBe(3)
		expect(toolCalls.every((c) => !c.ok)).toBe(true)
		// Trotz Abbruch bleibt eine verwertbare Antwort zurück.
		expect(result.text.trim()).not.toBe("")
	})

	it("beendet die Tool-Nutzung am Limit, liefert aber trotzdem eine vollständige Antwort", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-loop-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "loop")
		const deltas: string[] = []

		const result = await runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Endlos",
			baseDir,
			executionId: "e2",
			maxSteps: 3,
			onDelta: (t) => deltas.push(t),
			emitToolCall: () => {},
			log: () => {},
		})

		expect(result.steps).toBe(3)
		expect(result.toolOps).toBe(3)
		expect(result.stepLimitReached).toBe(true)
		expect(result.finalized).toBe(true)
		// 3 Schritte mit Tools + 1 Abschluss-Schritt ohne Tools.
		expect(adapter.requests).toHaveLength(4)
		expect(adapter.requests[3].tools).toBeUndefined()
		// Die Antwort ist da — nicht bloss ein Abbruch-Hinweis.
		expect(result.text).toContain("Abschluss: Ich habe out/hello.txt geschrieben.")
		expect(deltas.join("")).toContain("Abschluss: Ich habe out/hello.txt geschrieben.")
		expect(result.text).not.toContain("kann unvollständig sein")
	})

	it("fasst selbst zusammen, wenn auch der Abschluss-Schritt stumm bleibt", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-stumm-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "stumm")
		const deltas: string[] = []

		const result = await runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Stumm",
			baseDir,
			executionId: "e3",
			maxSteps: 2,
			onDelta: (t) => deltas.push(t),
			emitToolCall: () => {},
			log: () => {},
		})

		expect(result.stepLimitReached).toBe(true)
		expect(result.finalized).toBe(false)
		// Nie leer: DiriZ protokolliert den Arbeitsstand.
		expect(result.text.trim()).not.toBe("")
		expect(result.text).toContain("Arbeitsstand")
		expect(result.text).toContain("read_file(fehlt.txt)")
		expect(deltas.join("")).toContain("Arbeitsstand")
	})
})

/**
 * Ohne Schritt-Limit endet der Loop erst, wenn das Modell fertig ist — oder
 * wenn das Gesamt-Timeout abbricht. Ein Budget, das mitten in der Arbeit
 * zuschlägt, kostet mehr, als es schützt.
 */
describe("agent: unbegrenztes Tool-Budget", () => {
	it("läuft weiter, wo ein Budget von 3 längst abgebrochen hätte", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agent-unlimited-"))
		const adapter = new ToolFakeAdapter("fake", "ollama", "loop")
		const controller = new AbortController()

		// Der Fake ruft endlos Tools auf; gestoppt wird über das Signal —
		// genau wie im Betrieb durch das Gesamt-Timeout.
		let steps = 0
		const lauf = runAgentLoop({
			adapter,
			model: "m1",
			userPrompt: "Endlos",
			baseDir,
			executionId: "e-unlimited",
			maxSteps: 0,
			signal: controller.signal,
			onDelta: () => {},
			emitToolCall: () => {
				steps++
				if (steps >= 12) {
					controller.abort()
				}
			},
			log: () => {},
		})

		await expect(lauf).rejects.toThrow(/Abgebrochen/)
		// Deutlich mehr als die frühere Grenze von 8 bzw. 24 Schritten.
		expect(steps).toBeGreaterThanOrEqual(12)
		fs.rmSync(baseDir, { recursive: true, force: true })
	})
})

/**
 * Kontext-Budget: Ein Lauf, der zehn Dateien gelesen hat, schleppt sie in jedem
 * weiteren Schritt mit — und die Verarbeitungszeit wächst mit dem Verlauf.
 * Alte Tool-Ergebnisse werden deshalb eingedampft, die jüngsten nie.
 */
describe("trimContext", () => {
	const toolMsg = (n: number): ChatMessage => ({
		role: "tool",
		toolCallId: `c${n}`,
		content: JSON.stringify({ ok: true, detail: `Inhalt ${n} `.repeat(200) }),
	})

	it("lässt einen kleinen Verlauf unangetastet", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "kurz" }, toolMsg(1)]
		const res = trimContext(messages, 128_000)
		expect(res.trimmed).toBe(0)
		expect(res.messages).toEqual(messages)
	})

	it("dampft alte Ergebnisse ein, sobald es eng wird — die jüngsten bleiben", () => {
		const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) => toolMsg(i))
		const res = trimContext(messages, 4096)
		expect(res.trimmed).toBeGreaterThan(0)
		// Die letzten vier Ergebnisse sind unverändert — mit ihnen arbeitet das
		// Modell gerade.
		for (const i of [8, 9, 10, 11]) {
			expect(res.messages[i]).toEqual(messages[i])
		}
		// Die Struktur bleibt: jede Antwort hängt weiter an ihrem Aufruf.
		expect(res.messages).toHaveLength(messages.length)
		expect(res.messages.every((m, i) => m.toolCallId === messages[i]?.toolCallId)).toBe(true)
	})

	it("tut nichts ohne bekanntes Kontextfenster", () => {
		const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) => toolMsg(i))
		expect(trimContext(messages, undefined).trimmed).toBe(0)
	})
})
