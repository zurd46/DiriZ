/**
 * M9-Tests: Deklaration statt Doku.
 *
 * Jede LLM-Instanz führt dieselben drei Dokumente wie ein Spezialist, und
 * beide wirken: `init.md` setzt die Model-Voreinstellungen, `plan.md` wird zur
 * verbindlichen Arbeitsanweisung im System-Prompt. Zusätzlich: die systemweit
 * einstellbaren Vorlagen für die drei Dateien.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	Agent,
	ChatChunk,
	ChatRequest,
	DiscoveredModel,
	HealthStatus,
	InstanceDoc,
	InstanceModel,
	LLMProvider,
	ProviderDoc,
	ProviderType,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	createProvider,
	createTask,
	getInstance,
	getProvider,
	listAgentDocs,
	listInstanceDocs,
	listProviderDocs,
	saveAgentDoc,
	saveInstanceDoc,
	saveProviderDoc,
	upsertInstance,
} from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

/** Fake-Adapter, der die letzte Anfrage festhält — so prüfen wir den Prompt. */
class CaptureAdapter implements LLMProvider {
	readonly label = "Capture"
	readonly type: ProviderType = "ollama"
	last?: ChatRequest
	constructor(readonly id: string) {}
	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		this.last = req
		yield { type: "delta", text: "ok" }
		yield { type: "usage", tokensIn: 1, tokensOut: 1 }
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}
	/** Vor jedem Lauf zurücksetzen (Methode statt Zuweisung: kein TS-Narrowing). */
	reset(): void {
		this.last = undefined
	}
}

let db: Db
let app: FastifyInstance
let engine: ExecutionEngine
let adapter: CaptureAdapter
let providerId: string
let instance: InstanceModel

beforeAll(async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-decl-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-decl-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	const bus = new EventBus()
	const feedback = new Feedback()
	const log = () => {}
	const registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		() => undefined,
	)
	providerId = createProvider(db, { type: "ollama", label: "Lokal", baseUrl: "http://local" }).id
	adapter = new CaptureAdapter(providerId)
	registry.registerAdapter(providerId, "ollama", "Lokal", adapter)
	registry.recordSuccess(providerId)
	instance = upsertInstance(
		db,
		providerId,
		{ modelId: "qwen3:8b", displayName: "Qwen3 8B", contextWindow: 32_000, capabilities: ["code"] },
		"manual",
	)
	engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
	const ctx: AppContext = {
		db,
		bus,
		registry,
		engine,
		feedback,
		secret: Buffer.from("test-secret-0123456789abcdef0123456789abcdef"),
		workspaceDir,
		reposDir: fs.mkdtempSync(path.join(os.tmpdir(), "diriz-repos-")),
	}
	app = await buildApp(ctx)
})

afterAll(async () => {
	await app.close().catch(() => {})
	db.close()
})

async function createAgentViaApi(name: string, body: Record<string, unknown> = {}): Promise<Agent> {
	const res = await app.inject({ method: "POST", url: "/api/agents", payload: { name, ...body } })
	expect(res.statusCode).toBe(201)
	return res.json() as Agent
}

/** Führt eine Task auf der festen Instanz aus und liefert den System-Prompt. */
async function runAndCaptureSystemPrompt(agentId?: string): Promise<string | undefined> {
	adapter.reset()
	const task = createTask(db, {
		prompt: "Sag hallo",
		title: `Prompt-Test ${agentId ?? "ohne"}`,
		metadata: {
			privacy: "local-only",
			mode: "pinned",
			preferredProviderId: providerId,
			preferredModelId: instance.modelId,
		},
		assignmentMode: agentId ? "agent" : "auto",
		agentId,
	})
	const result = await engine.runTask(task)
	expect(result.status).toBe("done")
	return adapter.last?.messages.find((m) => m.role === "system")?.content
}

describe("Dokumente je LLM-Instanz", () => {
	it("legt plan/changelog/init beim Entdecken eines Modells an", async () => {
		expect(listInstanceDocs(db, instance.id).map((d) => d.kind)).toEqual(["plan", "changelog", "init"])
		const res = await app.inject({ method: "GET", url: `/api/instances/${instance.id}/docs` })
		expect(res.statusCode).toBe(200)
		const docs = (res.json() as { docs: InstanceDoc[] }).docs
		expect(docs.find((d) => d.kind === "plan")?.content).toContain("Qwen3 8B")
	})

	it("`init.md` setzt die Model-Voreinstellungen der Instanz", async () => {
		const res = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/init`,
			payload: { content: "- Temperature: 0.2\n- Max-Tokens: 1024\n" },
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as { settings: Record<string, number> }).settings).toEqual({
			temperature: 0.2,
			maxTokens: 1024,
		})
		expect(getInstance(db, instance.id)?.modelSettings).toEqual({ temperature: 0.2, maxTokens: 1024 })

		// Zurücksetzen — leeres init.md räumt die Voreinstellungen ab.
		saveInstanceDoc(db, instance.id, "init", "# init.md\n\nkeine Werte\n")
		expect(getInstance(db, instance.id)?.modelSettings).toBeNull()
	})

	it("PATCH schreibt init.md und einen Changelog-Eintrag", async () => {
		const res = await app.inject({
			method: "PATCH",
			url: `/api/instances/${instance.id}`,
			payload: { modelSettings: { temperature: 0.5 } },
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as InstanceModel).modelSettings).toEqual({ temperature: 0.5 })
		const docs = listInstanceDocs(db, instance.id)
		expect(docs.find((d) => d.kind === "init")?.content).toContain("Temperature: 0.5")
		expect(docs.find((d) => d.kind === "changelog")?.content).toContain("Bearbeitet: Model-Voreinstellungen")
		// Aufräumen für die Prompt-Tests.
		saveInstanceDoc(db, instance.id, "init", "# init.md\n")
	})

	it("übernimmt vorhandene Overrides einer Alt-Instanz ins init.md", () => {
		// Instanz ohne Dokumente, aber mit Settings — wie vor Migration 0007.
		const legacy = upsertInstance(
			db,
			providerId,
			{ modelId: "legacy:1", displayName: "Legacy", contextWindow: 4096 },
			"manual",
		)
		db.prepare("DELETE FROM instance_docs WHERE instance_id = ?").run(legacy.id)
		db.prepare("UPDATE instances SET model_settings = ? WHERE id = ?").run(
			JSON.stringify({ temperature: 0.9 }),
			legacy.id,
		)
		const init = listInstanceDocs(db, legacy.id).find((d) => d.kind === "init")?.content ?? ""
		expect(init).toContain("Temperature: 0.9")
		// Erneutes Speichern erhält die Werte, statt sie zu löschen.
		saveInstanceDoc(db, legacy.id, "init", init)
		expect(getInstance(db, legacy.id)?.modelSettings).toEqual({ temperature: 0.9 })
	})

	it("weist unbekannte Dokumenttypen und fehlende Instanzen ab", async () => {
		const badKind = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/readme`,
			payload: { content: "x" },
		})
		expect(badKind.statusCode).toBe(400)
		const missing = await app.inject({
			method: "PUT",
			url: "/api/instances/gibt-es-nicht/docs/plan",
			payload: { content: "x" },
		})
		expect(missing.statusCode).toBe(404)
	})
})

describe("plan.md wirkt im System-Prompt", () => {
	it("unbearbeitete Vorlagen erzeugen keine Anweisung", async () => {
		const agent = await createAgentViaApi("Leer-Agent")
		const prompt = await runAndCaptureSystemPrompt(agent.id)
		expect(prompt).toBeUndefined()
	})

	it("übernimmt plan.md von Instanz und Spezialist — allgemein vor spezifisch", async () => {
		const agent = await createAgentViaApi("Plan-Agent", { systemPrompt: "Du bist Code-Reviewer." })
		saveInstanceDoc(db, instance.id, "plan", "## Leitplanken\n\n- Antworte immer auf Deutsch.\n")
		saveAgentDoc(db, agent.id, "plan", "## Auftrag\n\nDu prüfst Diffs auf Fehler.\n")

		const prompt = await runAndCaptureSystemPrompt(agent.id)
		expect(prompt).toBeDefined()
		const text = prompt ?? ""
		expect(text.startsWith("Du bist Code-Reviewer.")).toBe(true)
		expect(text).toContain("Verbindliche Arbeitsanweisung")
		expect(text).toContain("Antworte immer auf Deutsch.")
		expect(text).toContain("Du prüfst Diffs auf Fehler.")
		expect(text.indexOf("Qwen3 8B")).toBeLessThan(text.indexOf("Plan-Agent"))
		// Vorlagen-Reste dürfen nie beim Modell landen.
		expect(text).not.toContain("Schritt 1")
		expect(text).not.toContain("Erstellt am")
	})

	it("Agenten-Feld schlägt init.md, Task-Override schlägt beide", async () => {
		// Instanz-Deklaration aus dem vorigen Test zurücksetzen — hier zählt nur die Rolle.
		saveInstanceDoc(db, instance.id, "plan", "# plan.md\n")
		const agent = await createAgentViaApi("Rollen-Agent")
		saveAgentDoc(db, agent.id, "init", "## System-Prompt\n\nRolle aus init.md\n")
		expect(await runAndCaptureSystemPrompt(agent.id)).toBe("Rolle aus init.md")

		await app.inject({
			method: "PATCH",
			url: `/api/agents/${agent.id}`,
			payload: { systemPrompt: "Rolle aus dem Agenten-Feld" },
		})
		expect(await runAndCaptureSystemPrompt(agent.id)).toBe("Rolle aus dem Agenten-Feld")

		adapter.reset()
		const task = createTask(db, {
			prompt: "Sag hallo",
			title: "Override-Test",
			metadata: {
				privacy: "local-only",
				mode: "pinned",
				preferredProviderId: providerId,
				preferredModelId: instance.modelId,
			},
			assignmentMode: "agent",
			agentId: agent.id,
			overrides: { systemPrompt: "Rolle aus dem Task" },
		})
		expect((await engine.runTask(task)).status).toBe("done")
		expect(adapter.last?.messages.find((m) => m.role === "system")?.content).toBe("Rolle aus dem Task")
	})

	it("Instanz-init.md wirkt auf die effektiven Model-Settings", async () => {
		saveInstanceDoc(db, instance.id, "init", "- Temperature: 0.11\n")
		await runAndCaptureSystemPrompt()
		expect(adapter.last?.settings?.temperature).toBe(0.11)
		saveInstanceDoc(db, instance.id, "init", "# init.md\n")
	})
})

describe("Dokument-Vorlagen (systemweit)", () => {
	it("werden gespeichert, ausgeliefert und für neue Einträge verwendet", async () => {
		const put = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: {
				docTemplates: {
					agent: { plan: "# plan.md — {{name}}\n\nStand {{datum}}: immer Tests schreiben.\n" },
					instance: { plan: "# {{datei}} für {{name}}\n\nNur Deutsch.\n" },
				},
			},
		})
		expect(put.statusCode).toBe(200)
		expect((put.json() as { docTemplates: { agent: { plan: string } } }).docTemplates.agent.plan).toContain(
			"{{name}}",
		)

		const agent = await createAgentViaApi("Vorlagen-Agent")
		const plan = listAgentDocs(db, agent.id).find((d) => d.kind === "plan")?.content ?? ""
		expect(plan).toContain("# plan.md — Vorlagen-Agent")
		expect(plan).toContain("immer Tests schreiben.")

		const fresh = upsertInstance(
			db,
			providerId,
			{ modelId: "llama3:70b", displayName: "Llama3 70B", contextWindow: 8192 },
			"manual",
		)
		const instPlan = listInstanceDocs(db, fresh.id).find((d) => d.kind === "plan")?.content ?? ""
		expect(instPlan).toContain("# plan.md für Llama3 70B")
		expect(instPlan).toContain("Nur Deutsch.")
	})

	it("weist ungültige Vorlagen ab und lässt Gewichte unangetastet", async () => {
		const bad = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { docTemplates: { agent: { plan: 42 } } },
		})
		expect(bad.statusCode).toBe(400)
		const empty = await app.inject({ method: "PUT", url: "/api/settings", payload: {} })
		expect(empty.statusCode).toBe(400)
	})
})

describe("Dokumente je Rechner (Provider)", () => {
	it("legt plan/changelog/init beim Anbinden an", async () => {
		expect(listProviderDocs(db, providerId).map((d) => d.kind)).toEqual(["plan", "changelog", "init"])
		const res = await app.inject({ method: "GET", url: `/api/providers/${providerId}/docs` })
		expect(res.statusCode).toBe(200)
		const docs = (res.json() as { docs: ProviderDoc[] }).docs
		expect(docs.find((d) => d.kind === "plan")?.content).toContain("Lokal")
	})

	it("`init.md` setzt die Voreinstellungen des Rechners", async () => {
		const res = await app.inject({
			method: "PUT",
			url: `/api/providers/${providerId}/docs/init`,
			payload: { content: "- Temperature: 0.33\n" },
		})
		expect(res.statusCode).toBe(200)
		expect(getProvider(db, providerId)?.modelSettings).toEqual({ temperature: 0.33 })
		saveProviderDoc(db, providerId, "init", "# init.md\n")
		expect(getProvider(db, providerId)?.modelSettings).toBeNull()
	})

	it("`plan.md` des Rechners steht als erste Deklaration im Prompt", async () => {
		saveProviderDoc(db, providerId, "plan", "## Leitplanken\n\n- Keine Cloud-Aufrufe.\n")
		saveInstanceDoc(db, instance.id, "plan", "## Auftrag\n\nKurze Antworten.\n")
		const text = (await runAndCaptureSystemPrompt()) ?? ""
		expect(text).toContain("Keine Cloud-Aufrufe.")
		expect(text.indexOf("Rechner Lokal")).toBeLessThan(text.indexOf("Modell Qwen3 8B"))
		saveProviderDoc(db, providerId, "plan", "# plan.md\n")
		saveInstanceDoc(db, instance.id, "plan", "# plan.md\n")
	})

	it("PATCH schreibt init.md und einen Changelog-Eintrag", async () => {
		const res = await app.inject({
			method: "PATCH",
			url: `/api/providers/${providerId}`,
			payload: { modelSettings: { temperature: 0.42 } },
		})
		expect(res.statusCode).toBe(200)
		const docs = listProviderDocs(db, providerId)
		expect(docs.find((d) => d.kind === "init")?.content).toContain("Temperature: 0.42")
		expect(docs.find((d) => d.kind === "changelog")?.content).toContain("Bearbeitet: Model-Voreinstellungen")
		saveProviderDoc(db, providerId, "init", "# init.md\n")
	})
})

describe("Sammel-Endpunkt /api/docs", () => {
	it("liefert alle drei Ebenen mit Schreibpfad und Inhalten", async () => {
		const agent = await createAgentViaApi("Übersicht-Agent")
		saveAgentDoc(db, agent.id, "plan", "## Auftrag\n\nEinzigartiger Suchbegriff Zwiebelfisch.\n")

		const res = await app.inject({ method: "GET", url: "/api/docs" })
		expect(res.statusCode).toBe(200)
		const owners = (
			res.json() as {
				owners: {
					kind: string
					id: string
					name: string
					basePath: string
					providerLabel?: string
					docs: Record<string, string>
				}[]
			}
		).owners

		expect(owners.some((o) => o.kind === "provider" && o.id === providerId)).toBe(true)
		const inst = owners.find((o) => o.kind === "instance" && o.id === instance.id)
		expect(inst?.providerLabel).toBe("Lokal")
		expect(inst?.basePath).toBe(`/api/instances/${instance.id}`)

		const entry = owners.find((o) => o.id === agent.id)
		expect(entry?.basePath).toBe(`/api/agents/${agent.id}`)
		expect(entry?.docs.plan).toContain("Zwiebelfisch")
		// Jeder Besitzer bringt alle drei Dokumente mit.
		for (const owner of owners) {
			expect(Object.keys(owner.docs).sort()).toEqual(["changelog", "init", "plan"])
		}
	})
})
