/**
 * M9-Tests: Agenten-Dokumente (`plan.md`, `changelog.md`, `init.md`) —
 * Anlage, Bearbeiten über die API, abgeleitete Model-Voreinstellungen aus
 * `init.md` und der automatische Changelog-Eintrag beim Bearbeiten.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Agent, AgentDoc } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { getAgent, listAgentDocs, saveAgentDoc } from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

let db: Db
let app: FastifyInstance

beforeAll(async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-docs-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-docs-ws-"))
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
	const engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
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

describe("Agenten-Dokumente", () => {
	it("legt plan/changelog/init beim Anlegen an", async () => {
		const agent = await createAgentViaApi("Doku-Agent")
		const res = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/docs` })
		expect(res.statusCode).toBe(200)
		const docs = (res.json() as { docs: AgentDoc[] }).docs
		expect(docs.map((d) => d.kind).sort()).toEqual(["changelog", "init", "plan"])
		expect(docs.find((d) => d.kind === "plan")?.content).toContain("Doku-Agent")
	})

	it("ergänzt Dokumente für Agenten aus der Zeit vor M9", () => {
		const now = new Date().toISOString()
		db.prepare(
			`INSERT INTO agents (id, name, description, system_prompt, required_capabilities, preferred_capabilities,
				privacy, pinned_provider_id, pinned_instance_id, model_settings, enabled, created_at, updated_at)
			 VALUES ('legacy', 'Alt-Agent', '', '', '[]', '[]', 'any', NULL, NULL, NULL, 1, ?, ?)`,
		).run(now, now)
		expect(listAgentDocs(db, "legacy").map((d) => d.kind)).toEqual(["plan", "changelog", "init"])
	})

	it("`init.md` setzt die Model-Voreinstellungen des Agenten", async () => {
		const agent = await createAgentViaApi("Init-Agent")
		const res = await app.inject({
			method: "PUT",
			url: `/api/agents/${agent.id}/docs/init`,
			payload: { content: "- Temperature: 0.15\n- Max-Tokens: 2048\n" },
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as { settings: Record<string, number> }).settings).toEqual({
			temperature: 0.15,
			maxTokens: 2048,
		})
		expect(getAgent(db, agent.id)?.modelSettings).toEqual({ temperature: 0.15, maxTokens: 2048 })

		// Leeres init.md räumt die Voreinstellungen wieder ab.
		saveAgentDoc(db, agent.id, "init", "# init.md\n\nkeine Werte\n")
		expect(getAgent(db, agent.id)?.modelSettings).toBeNull()
	})

	it("Bearbeiten über PATCH schreibt init.md und einen Changelog-Eintrag", async () => {
		const agent = await createAgentViaApi("Patch-Agent", { description: "alt" })
		const res = await app.inject({
			method: "PATCH",
			url: `/api/agents/${agent.id}`,
			payload: { description: "neu", modelSettings: { temperature: 0.4 } },
		})
		expect(res.statusCode).toBe(200)
		const updated = res.json() as Agent
		expect(updated.description).toBe("neu")
		expect(updated.modelSettings).toEqual({ temperature: 0.4 })

		const docs = listAgentDocs(db, agent.id)
		expect(docs.find((d) => d.kind === "init")?.content).toContain("Temperature: 0.4")
		expect(docs.find((d) => d.kind === "changelog")?.content).toContain(
			"Bearbeitet: Beschreibung, Model-Voreinstellungen",
		)
	})

	it("weist unbekannte Dokumenttypen und fehlende Agenten ab", async () => {
		const agent = await createAgentViaApi("Fehler-Agent")
		const badKind = await app.inject({
			method: "PUT",
			url: `/api/agents/${agent.id}/docs/readme`,
			payload: { content: "x" },
		})
		expect(badKind.statusCode).toBe(400)
		const missing = await app.inject({
			method: "PUT",
			url: "/api/agents/gibt-es-nicht/docs/plan",
			payload: { content: "x" },
		})
		expect(missing.statusCode).toBe(404)
	})

	it("Export/Import nimmt die Dokumente mit", async () => {
		const agent = await createAgentViaApi("Export-Agent")
		saveAgentDoc(db, agent.id, "plan", "# plan.md\n\nMein Plan\n")
		const exported = (await app.inject({ method: "GET", url: "/api/export" })).json() as {
			agents: { name: string; docs: Record<string, string> }[]
		}
		const entry = exported.agents.find((a) => a.name === "Export-Agent")
		expect(entry?.docs.plan).toContain("Mein Plan")

		saveAgentDoc(db, agent.id, "plan", "überschrieben")
		const imported = await app.inject({
			method: "POST",
			url: "/api/import",
			payload: { format: "diriz-export", agents: [entry] },
		})
		expect(imported.statusCode).toBe(200)
		expect(listAgentDocs(db, agent.id).find((d) => d.kind === "plan")?.content).toContain("Mein Plan")
	})
})
