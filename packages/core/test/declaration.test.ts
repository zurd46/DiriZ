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
import { contentText, parseLlmDoc } from "@diriz/shared"
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
	getProviderDoc,
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
	const sys = adapter.last?.messages.find((m) => m.role === "system")
	return sys ? contentText(sys.content) : undefined
}

describe("Dokumente je LLM-Instanz", () => {
	it("legt genau ein Dokument beim Entdecken eines Modells an — das Datenblatt", async () => {
		// Ein Modell bekommt keinen Auftrag (`plan.md`), kein Änderungsprotokoll
		// und kein eigenes `init.md` — nur sein Datenblatt.
		expect(listInstanceDocs(db, instance.id).map((d) => d.kind)).toEqual(["llm"])
		const res = await app.inject({ method: "GET", url: `/api/instances/${instance.id}/docs` })
		expect(res.statusCode).toBe(200)
		const docs = (res.json() as { docs: InstanceDoc[] }).docs
		const llm = docs.find((d) => d.kind === "llm")?.content ?? ""
		expect(llm).toContain("Qwen3 8B")
		expect(llm).toContain("## Fähigkeiten")
		expect(llm).toContain("## Gut für")
		expect(llm).toContain("## Nicht geeignet für")
		// Keine leere Vorlage: Der Katalog hat das Modell erkannt.
		expect(llm).toContain("Familie: Qwen")
		expect(llm).toContain("## Werkzeuge")
		expect(llm).toContain("## Voreinstellungen")
		expect(parseLlmDoc(llm).quality).toBeDefined()
	})

	it("überträgt die Fähigkeiten aus dem Datenblatt in die Instanz (Routing-Gate)", async () => {
		// Der Provider meldet keine Fähigkeiten — ohne Datenblatt wäre das Modell
		// im Routing fähigkeitslos und fiele durch jedes Pflicht-Gate.
		expect(getInstance(db, instance.id)?.capabilities.length).toBeGreaterThan(0)

		const res = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/llm`,
			payload: {
				content:
					"# llm.md\n\n## Steckbrief\n\n- Kontext-Fenster: 16384\n- Qualitätsklasse: hoch\n\n## Fähigkeiten\n\n- vision\n- json\n",
			},
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as { spec: { capabilities: string[] } }).spec.capabilities).toEqual(["vision", "json"])
		const updated = getInstance(db, instance.id)
		expect(updated?.capabilities).toEqual(["vision", "json"])
		expect(updated?.contextWindow).toBe(16384)
	})

	it("PATCH auf Fähigkeiten schreibt ins Datenblatt zurück", async () => {
		const res = await app.inject({
			method: "PATCH",
			url: `/api/instances/${instance.id}`,
			payload: { capabilities: ["code", "reasoning"], contextWindow: 32768 },
		})
		expect(res.statusCode).toBe(200)
		const llm = listInstanceDocs(db, instance.id).find((d) => d.kind === "llm")?.content ?? ""
		const spec = parseLlmDoc(llm)
		expect(spec.capabilities).toEqual(["code", "reasoning"])
		expect(spec.contextWindow).toBe(32768)
		expect(getInstance(db, instance.id)?.capabilities).toEqual(["code", "reasoning"])
	})

	it("`## Voreinstellungen` im Datenblatt setzt die Model-Parameter", async () => {
		const res = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/llm`,
			payload: {
				content: "# llm.md\n\n## Voreinstellungen\n\n- Temperature: 0.2\n- Max-Tokens: 1024\n",
			},
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as { settings: Record<string, number> }).settings).toEqual({
			temperature: 0.2,
			maxTokens: 1024,
		})
		expect(getInstance(db, instance.id)?.modelSettings).toEqual({ temperature: 0.2, maxTokens: 1024 })

		// Ohne Werte im Datenblatt gibt es keine Overrides mehr.
		saveInstanceDoc(db, instance.id, "llm", "# llm.md\n\nkeine Werte\n")
		expect(getInstance(db, instance.id)?.modelSettings).toBeNull()
	})

	it("PATCH schreibt die Voreinstellungen ins Datenblatt", async () => {
		const res = await app.inject({
			method: "PATCH",
			url: `/api/instances/${instance.id}`,
			payload: { modelSettings: { temperature: 0.5 } },
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as InstanceModel).modelSettings).toEqual({ temperature: 0.5 })
		const llm = listInstanceDocs(db, instance.id).find((d) => d.kind === "llm")?.content ?? ""
		expect(llm).toContain("Temperature: 0.5")
		expect(parseLlmDoc(llm).settings).toEqual({ temperature: 0.5 })
		// Aufräumen für die Prompt-Tests.
		saveInstanceDoc(db, instance.id, "llm", "# llm.md\n")
	})

	it("übernimmt vorhandene Overrides einer Alt-Instanz ins Datenblatt", () => {
		// Instanz ohne Dokumente, aber mit Settings — wie vor Migration 0007
		// bzw. aus der Zeit, als die Parameter noch im `init.md` standen.
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
		const llm = listInstanceDocs(db, legacy.id).find((d) => d.kind === "llm")?.content ?? ""
		expect(llm).toContain("Temperature: 0.9")
		// Erneutes Speichern erhält die Werte, statt sie zu löschen.
		saveInstanceDoc(db, legacy.id, "llm", llm)
		expect(getInstance(db, legacy.id)?.modelSettings).toEqual({ temperature: 0.9 })
	})

	it("weist unbekannte Dokumenttypen und fehlende Instanzen ab", async () => {
		const badKind = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/readme`,
			payload: { content: "x" },
		})
		expect(badKind.statusCode).toBe(400)
		// `plan.md` gibt es auf dieser Ebene nicht — ein Modell hat keinen Auftrag.
		const wrongKind = await app.inject({
			method: "PUT",
			url: `/api/instances/${instance.id}/docs/plan`,
			payload: { content: "x" },
		})
		expect(wrongKind.statusCode).toBe(400)
		const missing = await app.inject({
			method: "PUT",
			url: "/api/instances/gibt-es-nicht/docs/llm",
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

	it("übernimmt plan.md von Rechner und Spezialist — allgemein vor spezifisch", async () => {
		const agent = await createAgentViaApi("Plan-Agent", { systemPrompt: "Du bist Code-Reviewer." })
		const providerPlan = getProviderDoc(db, providerId, "plan")?.content ?? ""
		saveProviderDoc(db, providerId, "plan", "## Leitplanken\n\n- Antworte immer auf Deutsch.\n")
		saveAgentDoc(db, agent.id, "plan", "## Auftrag\n\nDu prüfst Diffs auf Fehler.\n")

		const prompt = await runAndCaptureSystemPrompt(agent.id)
		expect(prompt).toBeDefined()
		const text = prompt ?? ""
		expect(text.startsWith("Du bist Code-Reviewer.")).toBe(true)
		expect(text).toContain("Verbindliche Arbeitsanweisung")
		expect(text).toContain("Antworte immer auf Deutsch.")
		expect(text).toContain("Du prüfst Diffs auf Fehler.")
		expect(text.indexOf("Rechner Lokal")).toBeLessThan(text.indexOf("Plan-Agent"))
		// Das Datenblatt des Modells wirkt im Routing, nicht im Prompt.
		expect(text).not.toContain("Datenblatt")
		expect(text).not.toContain("Gut für")
		// Vorlagen-Reste dürfen nie beim Modell landen.
		expect(text).not.toContain("Schritt 1")
		expect(text).not.toContain("Erstellt am")
		saveProviderDoc(db, providerId, "plan", providerPlan)
	})

	it("Agenten-Feld schlägt init.md, Task-Override schlägt beide", async () => {
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
					instance: { llm: "# {{datei}} für {{name}}\n\nNur Deutsch.\n" },
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
		// Eine selbst gesetzte Vorlage gewinnt gegen das Datenblatt aus dem Katalog.
		const instLlm = listInstanceDocs(db, fresh.id).find((d) => d.kind === "llm")?.content ?? ""
		expect(instLlm).toContain("# llm.md für Llama3 70B")
		expect(instLlm).toContain("Nur Deutsch.")
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

	it("`plan.md` des Rechners steht als Deklaration im Prompt", async () => {
		const before = getProviderDoc(db, providerId, "plan")?.content ?? ""
		saveProviderDoc(db, providerId, "plan", "## Leitplanken\n\n- Keine Cloud-Aufrufe.\n")
		const text = (await runAndCaptureSystemPrompt()) ?? ""
		expect(text).toContain("Keine Cloud-Aufrufe.")
		expect(text).toContain("Rechner Lokal")
		saveProviderDoc(db, providerId, "plan", before)
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
		// Jeder Besitzer bringt genau die Dokumente seiner Ebene mit.
		for (const owner of owners) {
			const kinds = Object.entries(owner.docs)
				.filter(([, content]) => content.length > 0)
				.map(([kind]) => kind)
				.sort()
			expect(kinds, owner.name).toEqual(owner.kind === "instance" ? ["llm"] : ["changelog", "init", "plan"])
		}
	})
})

describe("Kontextbedarf des Spezialisten", () => {
	it("rechnet System-Prompt und plan.md in die Kontext-Schätzung ein", async () => {
		// Ein Spezialist mit umfangreicher Deklaration — wie ein echter
		// Security-Agent mit mehrseitigem plan.md.
		const agent = await createAgentViaApi("Kontext-Agent", {
			systemPrompt: "Du bist Sicherheitsprüfer. ".repeat(80),
		})
		saveAgentDoc(db, agent.id, "plan", `## Auftrag\n\n${"Prüfe jede Eingabe sorgfältig. ".repeat(200)}\n`)

		const task = createTask(db, {
			prompt: "Kurzer Prompt",
			title: "Kontext-Test",
			metadata: {
				privacy: "local-only",
				mode: "pinned",
				preferredProviderId: providerId,
				preferredModelId: instance.modelId,
			},
			assignmentMode: "agent",
			agentId: agent.id,
		})

		const preview = await engine.preview(task.id)
		const geschaetzt = preview?.decision.profile.estTokens ?? 0
		// Der Prompt allein wären ein paar Dutzend Tokens — die Deklaration
		// bringt es auf ein Vielfaches. Ohne diese Rechnung hielte das
		// Context-Gate ein zu kleines Modell für passend.
		expect(geschaetzt).toBeGreaterThan(1000)

		// Ein Spezialist ohne Deklaration bringt keinen Aufschlag mit.
		const schlank = await createAgentViaApi("Schlank-Agent")
		saveAgentDoc(db, schlank.id, "plan", "# plan.md\n")
		const ohne = createTask(db, {
			prompt: "Kurzer Prompt",
			title: "Kontext-Test schlank",
			metadata: {
				privacy: "local-only",
				mode: "pinned",
				preferredProviderId: providerId,
				preferredModelId: instance.modelId,
			},
			assignmentMode: "agent",
			agentId: schlank.id,
		})
		const ohnePreview = await engine.preview(ohne.id)
		const schlankTokens = ohnePreview?.decision.profile.estTokens ?? 0
		expect(schlankTokens).toBeLessThan(geschaetzt / 3)
		// Der Unterschied ist genau die Deklaration des großen Spezialisten.
		expect(geschaetzt - schlankTokens).toBeGreaterThan(1500)
	})
})
