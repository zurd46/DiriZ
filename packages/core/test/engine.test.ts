/**
 * Engine-Tests: Erfolgspfad, Failover (erster Provider schlägt fehl),
 * „keine Kandidatin“, Cancel. Fake-Adapter statt echter HTTP-Server.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	ChatChunk,
	ChatRequest,
	CoreEvent,
	DiscoveredModel,
	HealthStatus,
	LLMProvider,
	ProviderType,
} from "@diriz/shared"
import { DEFAULT_TIMEOUTS } from "@diriz/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	createProvider,
	createTask,
	getTask,
	latestDecision,
	listExecutionsByTask,
	listInstances,
	replayOutput,
	updateInstance,
	upsertInstance,
} from "../src/db/repositories.js"
import { istVorübergehend } from "../src/execution/agent.js"
import { EventBus } from "../src/execution/bus.js"
import {
	ExecutionEngine,
	lockDurationMs,
	looksLikeLoadFailure,
	NoCandidateError,
	summarizeExclusions,
	wirksamesFenster,
} from "../src/execution/engine.js"
import { taskWorktreePath } from "../src/execution/worktree.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

class FakeAdapter implements LLMProvider {
	readonly label = "Fake"
	constructor(
		readonly id: string,
		readonly type: ProviderType,
		private script: "ok" | "fail",
	) {}
	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		void req
		if (this.script === "fail") {
			throw new Error("Simulierter Provider-Ausfall")
		}
		yield { type: "delta", text: "Ergebnis: " }
		yield { type: "delta", text: "```file:path=src/out.txt\nhallo diriz\n```" }
		yield { type: "usage", tokensIn: 10, tokensOut: 20 }
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}
}

let db: Db
let bus: EventBus
let registry: ProviderRegistry
let engine: ExecutionEngine
let feedback: Feedback
let workspaceDir: string
let pFailId: string
let pOkId: string
const events: CoreEvent[] = []

beforeAll(() => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-engine-"))
	workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	bus = new EventBus()
	bus.subscribe((e) => events.push(e))
	feedback = new Feedback()
	const log = () => {}
	registry = new ProviderRegistry(
		db,
		(e) => events.push(e),
		log,
		() => undefined,
	)

	// Zwei Provider: erster schlägt fehl, zweiter liefert.
	pFailId = createProvider(db, { type: "ollama", label: "Fail", baseUrl: "http://fail" }).id
	pOkId = createProvider(db, { type: "ollama", label: "Ok", baseUrl: "http://ok" }).id
	registry.registerAdapter(pFailId, "ollama", "Fail", new FakeAdapter(pFailId, "ollama", "fail"))
	registry.registerAdapter(pOkId, "ollama", "Ok", new FakeAdapter(pOkId, "ollama", "ok"))
	upsertInstance(
		db,
		pFailId,
		{ modelId: "m-fail", displayName: "M Fail", contextWindow: 32_000, capabilities: ["code"] },
		"manual",
	)
	const instOk = upsertInstance(
		db,
		pOkId,
		{ modelId: "m-ok", displayName: "M Ok", contextWindow: 32_000, capabilities: ["code"] },
		"manual",
	)
	registry.recordSuccess(pFailId)
	registry.recordSuccess(pOkId)
	// „Ok“-Instanz schlechter bewerten, damit „Fail“ im Auto-Modus zuerst
	// gewählt wird (deterministischer Failover-Test).
	feedback.record(instOk.id, false)
	feedback.record(instOk.id, false)

	engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => events.push(e), log, workspaceDir })
})

afterAll(() => {
	db.close()
})

describe("engine: Erfolgspfad", () => {
	it("führt die Task durch, persistiert Chunks & Dateien, emittiert Events", async () => {
		events.length = 0
		const task = createTask(db, {
			prompt: "Schreib eine Datei",
			title: "Engine Test",
			metadata: { mode: "pinned", preferredProviderId: pOkId },
		})
		const result = await engine.runTask(task)

		expect(result.status).toBe("done")
		expect(result.tokensIn).toBe(10)
		expect(result.tokensOut).toBe(20)
		expect(result.failoverCount).toBe(0)
		expect(getTask(db, task.id)?.status).toBe("done")

		// Chunks replaybar
		expect(replayOutput(db, result.id)).toContain("Ergebnis:")

		// Workspace-Datei geschrieben + in DB
		const fileAbs = path.join(taskWorktreePath(workspaceDir, task), "src", "out.txt")
		expect(fs.readFileSync(fileAbs, "utf8")).toBe("hallo diriz\n")
		expect(result.files?.some((f) => f.relPath === "src/out.txt")).toBe(true)

		// Routing-Entscheidung persistiert
		const decision = latestDecision(db, result.id)
		expect(decision?.chosenInstanceId).toBeTruthy()
		expect(decision?.candidates.length).toBeGreaterThanOrEqual(1)
		expect(decision?.profile.estTokens).toBeGreaterThan(0)

		// Event-Folge
		const names = events.map((e) => e.event)
		expect(names).toContain("routing.decided")
		// `routing.decided` trägt die Task-ID: Ohne sie kann eine Ansicht einen
		// Live-Stream nicht ihrer eigenen Task zuordnen (Chat).
		const decided = events.find((e) => e.event === "routing.decided") as
			| { data: { taskId: string; executionId: string } }
			| undefined
		expect(decided?.data.taskId).toBe(task.id)
		expect(decided?.data.executionId).toBe(result.id)
		expect(names).toContain("execution.delta")
		expect(names).toContain("execution.usage")
		expect(names).toContain("execution.done")
	})
})

describe("engine: Failover", () => {
	it("wechselt bei Provider-Fehler auf die nächste Instanz", async () => {
		events.length = 0
		// Eigene Rechner nur für diesen Test: Sonst entscheidet die Vorgeschichte
		// aus anderen Tests mit — ein Modell, das dort schon gelaufen ist, hat
		// einen gemessenen Durchsatz und gewinnt damit zu Recht die Auswahl.
		const failId = createProvider(db, { type: "ollama", label: "Fail2", baseUrl: "http://fail2" }).id
		const okId = createProvider(db, { type: "ollama", label: "Ok2", baseUrl: "http://ok2" }).id
		registry.registerAdapter(failId, "ollama", "Fail2", new FakeAdapter(failId, "ollama", "fail"))
		registry.registerAdapter(okId, "ollama", "Ok2", new FakeAdapter(okId, "ollama", "ok"))
		upsertInstance(
			db,
			failId,
			{ modelId: "m-fail2", displayName: "M Fail 2", contextWindow: 32_000, capabilities: ["code"] },
			"manual",
		)
		const zweite = upsertInstance(
			db,
			okId,
			{ modelId: "m-ok2", displayName: "M Ok 2", contextWindow: 32_000, capabilities: ["code"] },
			"manual",
		)
		registry.recordSuccess(failId)
		registry.recordSuccess(okId)
		// Die Ersatz-Instanz schlechter bewerten, damit die fehlerhafte zuerst
		// gewählt wird — nur dann prüft der Test überhaupt das Failover.
		feedback.record(zweite.id, false)
		feedback.record(zweite.id, false)
		// Die Instanzen der übrigen Tests aus dem Rennen nehmen.
		for (const inst of registry.instances()) {
			if (![failId, okId].includes(inst.providerId)) {
				updateInstance(db, inst.id, { enabled: false })
			}
		}

		const task = createTask(db, { prompt: "Failover-Test" })
		const result = await engine.runTask(task)

		expect(result.status).toBe("done")
		expect(result.failoverCount).toBe(1)

		for (const inst of registry.instances()) {
			updateInstance(db, inst.id, { enabled: true })
		}

		const execs = [...listExecutionsByTask(db, task.id)].sort((a, b) => a.failoverCount - b.failoverCount)
		expect(execs).toHaveLength(2)
		expect(execs[0]?.status).toBe("failed")
		expect(execs[1]?.status).toBe("done")

		const failover = events.find((e) => e.event === "execution.failover")
		expect(failover).toBeTruthy()
		if (failover && failover.event === "execution.failover") {
			expect(failover.data.from).toBe("m-fail2")
			expect(failover.data.to).toBe("m-ok2")
		}
	})
})

describe("engine: keine Kandidatin", () => {
	it("weicht aus, wenn die Festlegung ins Leere zeigt", async () => {
		// Beobachtet: Der Spezialist war auf einen Rechner festgelegt, der das
		// Modell nicht mehr anbot (am Mac wurde „LM Link" abgeschaltet). Der
		// Wunsch dahinter war nie „ausschliesslich dieser Rechner" — DiriZ
		// lockert die Festlegung und sagt es im Protokoll.
		const task = createTask(db, {
			prompt: "Hallo",
			metadata: { privacy: "local-only", mode: "pinned", preferredProviderId: "gibts-nicht" },
		})
		const result = await engine.runTask(task)
		expect(result.status).toBe("done")
	})

	it("wirft NoCandidateError, wenn wirklich nichts übrig bleibt", async () => {
		// Kein Ausweichen ohne Ausweg: Sind alle Modelle abgeschaltet, ist die
		// Task unmöglich — und das gehört sichtbar gemacht, nicht überspielt.
		const vorher = listInstances(db).map((i) => ({ id: i.id, enabled: i.enabled }))
		for (const i of vorher) {
			db.prepare("UPDATE instances SET enabled = 0 WHERE id = ?").run(i.id)
		}
		try {
			const task = createTask(db, { prompt: "Hallo" })
			await expect(engine.runTask(task)).rejects.toBeInstanceOf(NoCandidateError)
			expect(getTask(db, task.id)?.status).toBe("failed")

			// Sichtbares Scheitern: eine fehlgeschlagene Execution mit Begründung existiert.
			const executions = listExecutionsByTask(db, task.id)
			expect(executions.length).toBe(1)
			expect(executions[0].status).toBe("failed")
			expect(executions[0].error).toContain("Keine Instanz verfügbar")
		} finally {
			for (const i of vorher) {
				db.prepare("UPDATE instances SET enabled = ? WHERE id = ?").run(i.enabled ? 1 : 0, i.id)
			}
		}
	})
})

describe("engine: Cancel", () => {
	it("bricht eine laufende Execution ab", async () => {
		const pCancel = createProvider(db, { type: "ollama", label: "Cancel", baseUrl: "http://cancel" }).id
		registry.registerAdapter(pCancel, "ollama", "Cancel", {
			id: pCancel,
			type: "ollama",
			label: "Cancel",
			healthCheck: async () => ({ ok: true, latencyMs: 1 }),
			listModels: async () => [],
			async *chat() {
				yield { type: "delta", text: "Start " }
				await new Promise((r) => setTimeout(r, 1500))
				yield { type: "delta", text: "nie" }
			},
			cancel: async () => {},
		})
		upsertInstance(
			db,
			pCancel,
			{ modelId: "m-cancel", displayName: "M Cancel", contextWindow: 32_000, capabilities: ["code"] },
			"manual",
		)
		registry.recordSuccess(pCancel)

		const task = createTask(db, {
			prompt: "Cancel-Test",
			metadata: { mode: "pinned", preferredProviderId: pCancel, preferredModelId: "m-cancel" },
		})
		const run = engine.runTask(task)
		await new Promise((r) => setTimeout(r, 100))
		const activeExecs = listExecutionsByTask(db, task.id)
		const execId = activeExecs[0]?.id
		expect(execId).toBeTruthy()
		expect(engine.cancel(execId ?? "")).toBe(true)
		await expect(run).rejects.toThrow("Abgebrochen")
		expect(getTask(db, task.id)?.status).toBe("cancelled")
	})
})

describe("engine: Routing-Preview (Dry-Run)", () => {
	it("liefert die Entscheidung ohne Execution & ohne Seiteneffekte", async () => {
		const task = createTask(db, { prompt: "Implementiere eine Funktion in TypeScript" })
		expect(getTask(db, task.id)?.status).toBe("draft")

		const decidedBefore = events.filter((e) => e.event === "routing.decided").length
		const preview = await engine.preview(task.id)
		const decidedAfter = events.filter((e) => e.event === "routing.decided").length

		expect(preview).toBeTruthy()
		expect(preview?.taskId).toBe(task.id)
		expect(preview?.decision.chosenInstanceId).toBeTruthy()
		expect(preview?.decision.candidates.length).toBeGreaterThan(0)
		expect(preview?.decision.executionId).toBe("")
		expect(preview?.decision.profile.estTokens).toBeGreaterThan(0)

		// Keine Seiteneffekte: keine Execution, Status unverändert, kein neues Event.
		expect(listExecutionsByTask(db, task.id)).toHaveLength(0)
		expect(getTask(db, task.id)?.status).toBe("draft")
		expect(decidedAfter).toBe(decidedBefore)
	})

	it("gibt undefined für unbekannte Task zurück", async () => {
		expect(await engine.preview("keine-id")).toBeUndefined()
	})
})

/** M8 Agentik: Fake-Adapter mit Tool-Support (write_file → finale Antwort). */
class AgentFakeAdapter implements LLMProvider {
	readonly label = "AgentFake"
	readonly supportsTools = true
	constructor(
		readonly id: string,
		readonly type: ProviderType,
	) {}
	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		const hasToolResult = req.messages.some((m) => m.role === "tool")
		if (!hasToolResult) {
			yield { type: "delta", text: "Ich nutze das Tool. " }
			yield {
				type: "tool_call",
				call: { id: "c1", name: "write_file", arguments: { path: "agent/out.txt", content: "via tool" } },
			}
		} else {
			yield { type: "delta", text: "Fertig!" }
		}
		yield { type: "usage", tokensIn: 7, tokensOut: 9 }
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}
}

describe("engine: Agentik-Modus (M8)", () => {
	let pAgentId: string

	beforeAll(() => {
		pAgentId = createProvider(db, { type: "ollama", label: "Agent", baseUrl: "http://agent" }).id
		registry.registerAdapter(pAgentId, "ollama", "Agent", new AgentFakeAdapter(pAgentId, "ollama"))
		upsertInstance(
			db,
			pAgentId,
			{ modelId: "m-agent", displayName: "M Agent", contextWindow: 32_000, capabilities: ["code"] },
			"manual",
		)
		registry.recordSuccess(pAgentId)
	})

	it("führt den Tool-Loop aus und emittiert tool.call (Transparenz)", async () => {
		events.length = 0
		const task = createTask(db, {
			prompt: "Schreib eine Datei per Tool",
			title: "Agentik Test",
			metadata: { mode: "pinned", preferredProviderId: pAgentId, agentMode: true },
		})
		const result = await engine.runTask(task)

		expect(result.status).toBe("done")
		expect(getTask(db, task.id)?.status).toBe("done")

		// Tool-Operation wurde live emittiert (M8 Transparenz-Anforderung).
		const toolEvents = events.filter((e) => e.event === "tool.call")
		expect(toolEvents.length).toBe(1)
		const op = toolEvents[0]
		if (op && op.event === "tool.call") {
			expect(op.data.name).toBe("write_file")
			expect(op.data.ok).toBe(true)
		}

		// Die Datei wurde per Tool in der Task-Sandbox geschrieben.
		const fileAbs = path.join(taskWorktreePath(workspaceDir, task), "agent", "out.txt")
		expect(fs.readFileSync(fileAbs, "utf8")).toBe("via tool")

		// Finale Antwort im Replay sichtbar.
		expect(replayOutput(db, result.id)).toContain("Fertig!")
	})
})

describe("Timeouts: erster Token vs. laufender Stream", () => {
	it("gibt dem ersten Token deutlich mehr Zeit als den folgenden", () => {
		// Bis zum ersten Token lädt der Server womöglich erst das Modell und
		// verarbeitet den ganzen Prompt — das dauert bei großen Modellen Minuten.
		// Ein Stream, der mittendrin verstummt, ist dagegen schnell ein Fehler.
		expect(DEFAULT_TIMEOUTS.firstChunkMs).toBeGreaterThan(DEFAULT_TIMEOUTS.chunkMs)
		expect(DEFAULT_TIMEOUTS.firstChunkMs).toBeGreaterThanOrEqual(120_000)
		// Und beides muss innerhalb der Gesamtdauer liegen.
		expect(DEFAULT_TIMEOUTS.totalMs).toBeGreaterThan(DEFAULT_TIMEOUTS.firstChunkMs)
	})
})

/**
 * Wenn nichts geht, muss wenigstens klar sein **warum**. „29 ausgeschlossen"
 * ohne Grund ist keine Auskunft, sondern eine Zumutung.
 */
describe("engine: Begründung beim Fehlschlag", () => {
	it("fasst die häufigsten Ausschlussgründe zusammen", () => {
		const text = summarizeExclusions([
			{ reason: "Provider offline oder Circuit-Breaker offen" },
			{ reason: "Provider offline oder Circuit-Breaker offen" },
			{ reason: "Fehlende Pflicht-Fähigkeiten: reasoning" },
			{ reason: "Context-Fenster zu klein: 8192 < 25759 Tokens" },
			{ reason: "Context-Fenster zu klein: 4096 < 25759 Tokens" },
			{ reason: "Context-Fenster zu klein: 2048 < 25759 Tokens" },
		])
		// Häufigstes zuerst, Details (Zahlen, Modellnamen) fallen weg.
		expect(text).toBe(
			"3× Context-Fenster zu klein · 2× Provider offline oder Circuit-Breaker offen · 1× Fehlende Pflicht-Fähigkeiten",
		)
	})

	it("kommt mit einer leeren Liste zurecht", () => {
		expect(summarizeExclusions([])).toBe("")
	})
})

/**
 * Ein Modell pro Rechner ist die Regel — aber der Wechsel muss klappen.
 * Scheitert ein Ladevorgang (der Speicher ist belegt), zählt für den nächsten
 * Versuch nicht mehr der beste Score, sondern was schon geladen ist.
 */
describe("engine: Wechsel nach Ladefehler", () => {
	it("erkennt Ladefehler und trennt sie von gewöhnlichen Fehlern", () => {
		expect(looksLikeLoadFailure('Failed to load model "qwen3". Engine protocol startup was aborted.')).toBe(
			true,
		)
		expect(looksLikeLoadFailure("Kein Chunk seit 180 s")).toBe(false)
	})
})

describe("engine: Ladefehler-Treppe", () => {
	it("verlängert die Sperre mit jedem weiteren Fehlschlag", () => {
		// Der erste Fehlschlag ist eine Momentaufnahme, der vierte eine
		// Eigenschaft des Modells — 158 GB werden nicht kleiner.
		expect(lockDurationMs(1)).toBe(10 * 60_000)
		expect(lockDurationMs(2)).toBe(60 * 60_000)
		expect(lockDurationMs(3)).toBe(6 * 60 * 60_000)
		expect(lockDurationMs(4)).toBe(24 * 60 * 60_000)
		expect(lockDurationMs(9)).toBe(24 * 60 * 60_000)
	})
})

describe("engine: Kontextfenster nach der Wahrheit des Rechners", () => {
	it("rechnet mit dem geladenen Fenster, nicht mit dem Maximum", () => {
		// Gemessen: qwen-agentworld meldet 262144, geladen war es mit 60160.
		expect(wirksamesFenster({ contextWindow: 262_144, loadedContextWindow: 60_160 })).toBe(60_160)
		// Ohne Beobachtung bleibt es beim gemeldeten Wert.
		expect(wirksamesFenster({ contextWindow: 32_768 })).toBe(32_768)
		// Und ein grösseres geladenes Fenster hebt die Fähigkeit nicht an.
		expect(wirksamesFenster({ contextWindow: 8192, loadedContextWindow: 60_160 })).toBe(8192)
	})
})

describe("Agent-Loop: vorübergehende Fehler", () => {
	it("unterscheidet ein Serverzucken von einem echten Hindernis", () => {
		// Wiederholen lohnt sich:
		expect(istVorübergehend("HTTP 500 Internal Server Error — HTML-Antwort: Error")).toBe(true)
		expect(istVorübergehend("terminated")).toBe(true)
		expect(istVorübergehend("Model is unloaded.")).toBe(true)
		expect(istVorübergehend("fetch failed")).toBe(true)
		// Wiederholen ändert nichts — hier gehört der Failover hin:
		expect(istVorübergehend("request (70017 tokens) exceeds the available context size")).toBe(false)
		// Ein verdrängtes Modell meldet sich als HTTP 400 — es ist trotzdem ein
		// Serverzustand und keine Anwendungssache. Live gestolpert.
		expect(
			istVorübergehend(
				"HTTP 400 Bad Request — Failed to load model. Error: Engine protocol startup was aborted.",
			),
		).toBe(true)
		// Ein Modell, das nicht in den Speicher passt, passt auch beim dritten
		// Versuch nicht — dort gehört der Failover hin, nicht Geduld.
		expect(istVorübergehend("Failed to load model. Error: requires approximately 158.94 GB of memory")).toBe(
			false,
		)
	})
})

describe("GPU-Schutz zählt Rechner, nicht Zugänge", () => {
	it("erkennt durchgereichte Modelle als dasselbe Gerät", () => {
		// Der Aufbau des Nutzers: `MacDani` ist ein Mac, der über LM Link die
		// Modelle eines Windows-Rechners durchreicht. Zwei Anfragen an denselben
		// Endpunkt landen also auf zwei verschiedenen Rechnern — und zwei
		// Anfragen an verschiedene Endpunkte auf demselben.
		const db2 = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-geraet-")))
		migrate(db2)
		const mac = createProvider(db2, { type: "lmstudio", label: "MacDani", baseUrl: "http://127.0.0.1:1234" })
		const win = createProvider(db2, { type: "lmstudio", label: "lokalai", baseUrl: "https://x.ngrok.dev" })
		const eigen = upsertInstance(
			db2,
			mac.id,
			{ modelId: "qwen3.8-27b", displayName: "q", contextWindow: 8192, deviceName: "MacBook-Pro" },
			"discovered",
		)
		const durchgereicht = upsertInstance(
			db2,
			mac.id,
			{ modelId: "nemotron", displayName: "n", contextWindow: 8192, deviceName: "LokalAI_Server1" },
			"discovered",
		)
		const direkt = upsertInstance(
			db2,
			win.id,
			{ modelId: "agentworld", displayName: "a", contextWindow: 8192, deviceName: "LokalAI_Server1" },
			"discovered",
		)

		const engine2 = new ExecutionEngine({
			db: db2,
			registry,
			feedback,
			emit: () => {},
			log: () => {},
			workspaceDir,
		})
		// Zugriff auf die interne Gerätezuordnung — sie ist der Kern des Schutzes.
		const schluessel = (i: typeof eigen) =>
			(engine2 as unknown as { geraetSchluessel: (x: typeof eigen) => string }).geraetSchluessel(i)

		// Verschiedene Endpunkte, gleicher Rechner → derselbe Schlüssel.
		expect(schluessel(durchgereicht)).toBe(schluessel(direkt))
		// Gleicher Endpunkt, verschiedene Rechner → verschiedene Schlüssel.
		expect(schluessel(eigen)).not.toBe(schluessel(durchgereicht))
		db2.close()
	})
})
