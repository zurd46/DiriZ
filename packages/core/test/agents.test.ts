/**
 * M1-Tests: Agent-/Swarm-Repository, Engine-Zuordnung (auto/agent/swarm),
 * Agent-Pin, System-Prompt-Injection und Model-Settings-Merge
 * (Provider ← Modell ← Task).
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	createAgent,
	createProvider,
	createSwarm,
	createTask,
	deleteAgent,
	deleteSwarm,
	getAgent,
	getSwarm,
	getTask,
	latestAgentSelection,
	listAgents,
	listExecutionsByTask,
	listTasks,
	saveAgentDoc,
	updateAgent,
	updateInstance,
	updateSwarm,
	upsertInstance,
} from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine, trimMarkdown } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

/** Adapter, der den letzten Request aufzeichnet (Settings, System-Prompt). */
class RecordingAdapter implements LLMProvider {
	readonly label = "Rec"
	lastRequest: ChatRequest | undefined

	constructor(
		readonly id: string,
		readonly type: ProviderType,
		private out: string,
	) {}

	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		this.lastRequest = req
		yield { type: "delta", text: this.out }
		yield { type: "usage", tokensIn: 5, tokensOut: 10 }
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}

	/** Setzt die Aufzeichnung zurück (ohne den Typ am Feld einzuengen). */
	reset(): void {
		this.lastRequest = undefined
	}
}

let db: Db
let engine: ExecutionEngine
let registry: ProviderRegistry
let pAId: string
let pBId: string
let instAId: string
let adapterA: RecordingAdapter
let adapterB: RecordingAdapter
let agentCode: string
let agentText: string
let swarmId: string

beforeAll(() => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agents-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-agents-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	const bus = new EventBus()
	const feedback = new Feedback()
	const log = () => {}
	registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		() => undefined,
	)

	// Rechner A: Provider-Default temperature 0.2, Modell-Override topP 0.5.
	pAId = createProvider(db, {
		type: "ollama",
		label: "Rechner A",
		baseUrl: "http://a",
		modelSettings: { temperature: 0.2 },
	}).id
	instAId = upsertInstance(
		db,
		pAId,
		{ modelId: "mA", displayName: "M A", contextWindow: 32_000, capabilities: ["code"] },
		"manual",
	).id
	updateInstance(db, instAId, { modelSettings: { topP: 0.5 } })

	// Rechner B: ohne Settings.
	pBId = createProvider(db, { type: "ollama", label: "Rechner B", baseUrl: "http://b" }).id
	upsertInstance(
		db,
		pBId,
		{ modelId: "mB", displayName: "M B", contextWindow: 32_000, capabilities: ["code"] },
		"manual",
	)

	adapterA = new RecordingAdapter(pAId, "ollama", "A-Antwort")
	adapterB = new RecordingAdapter(pBId, "ollama", "B-Antwort")
	registry.registerAdapter(pAId, "ollama", "A", adapterA)
	registry.registerAdapter(pBId, "ollama", "B", adapterB)
	registry.recordSuccess(pAId)
	registry.recordSuccess(pBId)

	// Spezialisten.
	agentCode = createAgent(db, {
		name: "Code-Dev",
		description: "React TypeScript Code Bug",
		systemPrompt: "Du bist der Code-Spezialist.",
		requiredCapabilities: ["code"],
		privacy: "any",
		pinnedProviderId: pAId,
	}).id
	agentText = createAgent(db, {
		name: "Texter",
		description: "Artikel Blog Essay Übersetzung",
		privacy: "any",
	}).id
	swarmId = createSwarm(db, { name: "Frontend", agentIds: [agentText, agentCode] }).id

	engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
})

afterAll(() => {
	db.close()
})

async function waitForTask(taskId: string, terminal: boolean = true): Promise<void> {
	const deadline = Date.now() + 5000
	for (;;) {
		const t = getTask(db, taskId)
		if (t && (!terminal || t.status === "done" || t.status === "failed" || t.status === "cancelled")) {
			return
		}
		if (Date.now() > deadline) {
			throw new Error(`Task ${taskId} nicht fertig (Status: ${getTask(db, taskId)?.status})`)
		}
		await new Promise((r) => setTimeout(r, 25))
	}
}

describe("M1: Repository", () => {
	it("Agent CRUD", () => {
		const a = createAgent(db, { name: "Temp", description: "x", systemPrompt: "y" })
		expect(getAgent(db, a.id)?.name).toBe("Temp")
		expect(listAgents(db).some((x) => x.id === a.id)).toBe(true)
		const updated = updateAgent(db, a.id, { name: "Temp2", enabled: false })
		expect(updated?.name).toBe("Temp2")
		expect(updated?.enabled).toBe(false)
		expect(deleteAgent(db, a.id)).toBe(true)
		expect(getAgent(db, a.id)).toBeUndefined()
	})

	it("Swarm CRUD", () => {
		const s = createSwarm(db, { name: "Temp", agentIds: [agentCode] })
		expect(getSwarm(db, s.id)?.agentIds).toEqual([agentCode])
		const updated = updateSwarm(db, s.id, { agentIds: [] })
		expect(updated?.agentIds).toEqual([])
		expect(deleteSwarm(db, s.id)).toBe(true)
	})

	it("Task-Defaults: assignmentMode auto, keine Agenten", () => {
		const t = createTask(db, { prompt: "hallo" })
		expect(t.assignmentMode).toBe("auto")
		expect(t.agentId).toBeUndefined()
	})
})

describe("M1: Engine-Zuordnung", () => {
	it("auto: wählt den passenden Spezialisten, pinnt den Rechner, injiziert System-Prompt & Settings", async () => {
		const task = createTask(db, {
			prompt: "Schreib eine React TypeScript Komponente",
			assignmentMode: "auto",
			overrides: { maxTokens: 256 },
		})
		const res = engine.start(task.id)
		expect(res.accepted).toBe(true)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("done")

		// Spezialist wurde automatisch gewählt und persistiert.
		const sel = latestAgentSelection(db, task.id)
		expect(sel?.agentId).toBe(agentCode)
		expect(sel?.reason).toContain("Zuordnung")
		expect(getTask(db, task.id)?.agentId).toBe(agentCode)

		// Pin: Execution läuft auf Rechner A (pinnedProviderId).
		const exec = listExecutionsByTask(db, task.id).find((e) => e.status === "done")
		expect(exec?.providerId).toBe(pAId)

		// System-Prompt des Spezialisten + Settings-Merge (Provider ← Modell ← Task).
		const req = adapterA.lastRequest
		expect(req?.messages?.[0]).toEqual({ role: "system", content: "Du bist der Code-Spezialist." })
		expect(req?.messages?.[1]?.role).toBe("user")
		expect(req?.settings?.temperature).toBe(0.2)
		expect(req?.settings?.topP).toBe(0.5)
		expect(req?.settings?.maxTokens).toBe(256)
	})

	it("auto: ohne relevanten Agent bleibt das Routing frei", async () => {
		adapterA.lastRequest = undefined
		adapterB.lastRequest = undefined
		const task = createTask(db, { prompt: "hallo", assignmentMode: "auto" })
		engine.start(task.id)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("done")
		const sel = latestAgentSelection(db, task.id)
		expect(sel?.agentId).toBeNull()
		expect(sel?.reason).toContain("freies Routing")
		// Kein System-Prompt ohne Agent (am Adapter des gewählten Rechners).
		const exec = listExecutionsByTask(db, task.id).find((e) => e.status === "done")
		const req = (exec?.providerId === pAId ? adapterA : adapterB).lastRequest
		expect(req?.messages?.[0]?.role).toBe("user")
	})

	it("agent: manueller Spezialist wird respektiert", async () => {
		const task = createTask(db, {
			prompt: "Schreib einen Artikel",
			assignmentMode: "agent",
			agentId: agentText,
		})
		engine.start(task.id)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("done")
		const sel = latestAgentSelection(db, task.id)
		expect(sel?.agentId).toBe(agentText)
		expect(sel?.reason).toContain("Manuell")
	})

	it("swarm: wählt den besten Mitglied-Agenten für den Prompt", async () => {
		const task = createTask(db, {
			prompt: "Schreib eine React Komponente in TypeScript",
			assignmentMode: "swarm",
			swarmId,
		})
		engine.start(task.id)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("done")
		const sel = latestAgentSelection(db, task.id)
		expect(sel?.agentId).toBe(agentCode)
		expect(sel?.reason).toContain("Swarm")
		expect(sel?.candidates?.length).toBe(2)
	})

	it("agent-Modus ohne Agent → Task schlägt fehl (klare Fehlermeldung)", async () => {
		const task = createTask(db, { prompt: "irgendwas", assignmentMode: "agent" })
		engine.start(task.id)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("failed")
	})

	it("deaktivierter Agent wird nie zugewiesen (auto)", async () => {
		updateAgent(db, agentCode, { enabled: false })
		try {
			const task = createTask(db, {
				prompt: "Schreib eine React TypeScript Komponente",
				assignmentMode: "auto",
			})
			engine.start(task.id)
			await waitForTask(task.id)
			const sel = latestAgentSelection(db, task.id)
			expect(sel?.agentId).not.toBe(agentCode)
		} finally {
			updateAgent(db, agentCode, { enabled: true })
		}
	})
})

describe("M9: Model-Voreinstellungen aus init.md", () => {
	it("Agent-Settings schlagen Provider/Modell — und die Task schlägt den Agenten", async () => {
		adapterA.reset()
		saveAgentDoc(db, agentCode, "init", "- Temperature: 0.9\n- Top-P: 0.1\n- Max-Tokens: 999\n")
		expect(getAgent(db, agentCode)?.modelSettings).toEqual({
			temperature: 0.9,
			topP: 0.1,
			maxTokens: 999,
		})

		const task = createTask(db, {
			prompt: "Schreib eine React TypeScript Komponente",
			assignmentMode: "agent",
			agentId: agentCode,
			overrides: { maxTokens: 111 },
		})
		engine.start(task.id)
		await waitForTask(task.id)
		expect(getTask(db, task.id)?.status).toBe("done")

		const req = adapterA.lastRequest
		expect(req?.settings?.temperature).toBe(0.9) // Agent schlägt Provider-Default 0.2
		expect(req?.settings?.topP).toBe(0.1) // Agent schlägt Modell-Override 0.5
		expect(req?.settings?.maxTokens).toBe(111) // Task schlägt den Agenten

		saveAgentDoc(db, agentCode, "init", "")
		expect(getAgent(db, agentCode)?.modelSettings).toBeNull()
	})
})

/**
 * Kette: Ein Auftrag, mehrere Spezialisten nacheinander. Der zweite Schritt
 * muss automatisch starten und die Vorarbeit des ersten kennen — sonst
 * beantwortet jeder Schritt dieselbe Frage von vorn.
 */
describe("engine: Spezialisten-Kette", () => {
	it("startet den nächsten Schritt und reicht das Ergebnis weiter", async () => {
		const erster = createAgent(db, { name: "Ketten-Erster", systemPrompt: "A" })
		const zweiter = createAgent(db, { name: "Ketten-Zweiter", systemPrompt: "B" })

		const task = createTask(db, {
			title: "Kette",
			prompt: "Ursprungsauftrag der Kette",
			assignmentMode: "agent",
			agentId: erster.id,
			metadata: { chain: { agentIds: [erster.id, zweiter.id], index: 0 } },
		})
		await engine.runTask(task)

		// Der Core hat eine Folge-Task angelegt — mit dem zweiten Spezialisten …
		const folge = listTasks(db).find(
			(t) => t.id !== task.id && t.metadata.chain?.index === 1 && t.agentId === zweiter.id,
		)
		expect(folge).toBeDefined()
		// … dem ursprünglichen Ziel und der Vorarbeit im Prompt.
		expect(folge?.prompt).toContain("Ursprungsauftrag der Kette")
		expect(folge?.prompt).toContain("Vorarbeit aus Stufe 1")
		expect(folge?.metadata.chain?.agentIds).toEqual([erster.id, zweiter.id])
		// Sauberes Markdown mit festen Überschriften: Die Oberfläche zerlegt die
		// Übergabe daran, und das Modell liest sie als gegliederten Auftrag.
		expect(folge?.prompt).toMatch(/^## Ursprünglicher Auftrag$/m)
		expect(folge?.prompt).toMatch(/^## Vorarbeit aus Stufe 1$/m)
		expect(folge?.prompt).toMatch(/^## Deine Aufgabe$/m)
	})

	it("startet eine Stufe mit mehreren Spezialisten gleichzeitig", async () => {
		const analyst = createAgent(db, { name: "Stufen-Analyst", systemPrompt: "A" })
		const bauer = createAgent(db, { name: "Stufen-Bauer", systemPrompt: "B" })
		const daten = createAgent(db, { name: "Stufen-Daten", systemPrompt: "C" })

		// Stufe 1: einer klärt. Stufe 2: zwei bauen — gleichzeitig.
		const stages = [[analyst.id], [bauer.id, daten.id]]
		const task = createTask(db, {
			title: "Stufen",
			prompt: "Auftrag mit zwei parallelen Schritten",
			assignmentMode: "agent",
			agentId: analyst.id,
			metadata: {
				chain: { id: "kette-1", agentIds: [analyst.id, bauer.id, daten.id], index: 0, stages, stage: 0 },
			},
		})
		await engine.runTask(task)

		const stufe2 = listTasks(db).filter(
			(t) => t.metadata.chain?.id === "kette-1" && t.metadata.chain?.stage === 1,
		)
		expect(stufe2).toHaveLength(2)
		expect(stufe2.map((t) => t.agentId).sort()).toEqual([bauer.id, daten.id].sort())
		// Beide sehen dieselbe Vorarbeit derselben Stufe.
		for (const t of stufe2) {
			expect(t.prompt).toContain("## Vorarbeit aus Stufe 1")
			expect(t.prompt).toContain("Auftrag mit zwei parallelen Schritten")
		}
	})

	it("wartet mit der nächsten Stufe, bis alle Geschwister fertig sind", async () => {
		const a = createAgent(db, { name: "Warte-A", systemPrompt: "A" })
		const b = createAgent(db, { name: "Warte-B", systemPrompt: "B" })
		const c = createAgent(db, { name: "Warte-C", systemPrompt: "C" })
		const stages = [[a.id, b.id], [c.id]]

		const chain = (stage: number) => ({
			id: "kette-2",
			agentIds: [a.id, b.id, c.id],
			index: stage,
			stages,
			stage,
		})
		const ersteA = createTask(db, {
			prompt: "Parallel A",
			assignmentMode: "agent",
			agentId: a.id,
			metadata: { chain: chain(0) },
		})
		const ersteB = createTask(db, {
			prompt: "Parallel B",
			assignmentMode: "agent",
			agentId: b.id,
			metadata: { chain: chain(0) },
		})

		// A ist fertig, B läuft noch → Stufe 2 darf nicht starten.
		await engine.runTask(ersteA)
		expect(
			listTasks(db).filter((t) => t.metadata.chain?.id === "kette-2" && t.metadata.chain?.stage === 1),
		).toHaveLength(0)

		// Jetzt wird auch B fertig — der Letzte zieht die Kette weiter.
		await engine.runTask(ersteB)
		const stufe2 = listTasks(db).filter(
			(t) => t.metadata.chain?.id === "kette-2" && t.metadata.chain?.stage === 1,
		)
		expect(stufe2).toHaveLength(1)
		// Die Vorarbeit trägt beide Beiträge, jeweils mit Namen.
		expect(stufe2[0]?.prompt).toContain("### Warte-A")
		expect(stufe2[0]?.prompt).toContain("### Warte-B")
	})

	it("endet nach dem letzten Schritt", async () => {
		const einzig = createAgent(db, { name: "Ketten-Letzter", systemPrompt: "C" })
		const vorher = listTasks(db).length
		const task = createTask(db, {
			prompt: "Letzter Schritt",
			assignmentMode: "agent",
			agentId: einzig.id,
			metadata: { chain: { agentIds: [einzig.id], index: 0 } },
		})
		await engine.runTask(task)
		// Nur die Task selbst ist dazugekommen, keine Fortsetzung.
		expect(listTasks(db).length).toBe(vorher + 1)
	})
})

/**
 * Ein geordneter Swarm ist ein Arbeitsablauf: Alle Mitglieder arbeiten
 * nacheinander in **ihrer** Reihenfolge — nicht der beste allein.
 */
describe("engine: Swarm als Arbeitsablauf", () => {
	it("startet mit dem ersten Mitglied und verankert die Kette", async () => {
		const eins = createAgent(db, { name: "Ablauf Eins", systemPrompt: "1" })
		const zwei = createAgent(db, { name: "Ablauf Zwei", systemPrompt: "2" })
		const drei = createAgent(db, { name: "Ablauf Drei", systemPrompt: "3" })
		// Absicht: Das **letzte** Mitglied passt am besten zum Prompt — trotzdem
		// muss der Ablauf vorn beginnen.
		updateAgent(db, drei.id, { description: "raketen raketen raketen" })
		const swarm = createSwarm(db, {
			name: "Dreischritt",
			agentIds: [eins.id, zwei.id, drei.id],
			ordered: true,
		})

		const task = createTask(db, {
			prompt: "raketen bauen",
			assignmentMode: "swarm",
			swarmId: swarm.id,
		})
		await engine.runTask(task)

		const sel = latestAgentSelection(db, task.id)
		expect(sel?.agentName).toBe("Ablauf Eins")
		expect(sel?.reason).toContain("Arbeitsablauf")
		// Die Kette steht in den Metadaten und der zweite Schritt läuft bereits.
		expect(getTask(db, task.id)?.metadata.chain?.agentIds).toEqual([eins.id, zwei.id, drei.id])
		expect(listTasks(db).some((t) => t.agentId === zwei.id && t.metadata.chain?.index === 1)).toBe(true)
	})

	it("wählt bei einem ungeordneten Swarm weiterhin den besten", async () => {
		const a = createAgent(db, { name: "Gruppe A", description: "unwichtig", systemPrompt: "A" })
		const b = createAgent(db, { name: "Gruppe B", description: "helikopter", systemPrompt: "B" })
		const swarm = createSwarm(db, { name: "Gruppe", agentIds: [a.id, b.id] })
		const task = createTask(db, { prompt: "helikopter", assignmentMode: "swarm", swarmId: swarm.id })
		await engine.runTask(task)
		expect(latestAgentSelection(db, task.id)?.agentName).toBe("Gruppe B")
	})
})

/**
 * Kürzen darf das Markdown nicht zerstören. Ein `slice()` mitten in einen
 * Code-Block liess dessen Zaun offen — im Chat verschluckte er alles Folgende,
 * und die Übergabe erschien als eine einzige unformatierte Wand.
 */
describe("trimMarkdown", () => {
	it("lässt kurzen Text unangetastet", () => {
		expect(trimMarkdown("# Titel\n\nKurz.", 6000)).toBe("# Titel\n\nKurz.")
	})

	it("schneidet an der Zeilengrenze und markiert die Kürzung", () => {
		const text = ["Zeile eins", "Zeile zwei", "Zeile drei"].join("\n")
		const out = trimMarkdown(text, 15)
		expect(out).toContain("Zeile eins")
		expect(out).not.toContain("Zeile drei")
		expect(out).toContain("gekürzt")
		// Keine halbe Zeile.
		expect(out.split("\n").some((l) => l === "Zeile zw")).toBe(false)
	})

	it("schliesst einen offenen Code-Block", () => {
		const text = ["Text davor", "```ts", "const a = 1", "const b = 2", "```", "Danach"].join("\n")
		const out = trimMarkdown(text, 30)
		const fences = out.split("\n").filter((l) => l.startsWith("```")).length
		expect(fences % 2).toBe(0)
	})
})
