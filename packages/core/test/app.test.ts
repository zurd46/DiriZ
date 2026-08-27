/**
 * API-Tests: Fastify-Routen per `inject`, plus ein echter SSE-Stream-Check.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type CoreEvent, SOFTWARE_TEAM } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	createProvider,
	listCompareTasks,
	listInstances,
	providerApiKeyEnc,
	upsertInstance,
} from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"
import { decryptString } from "../src/security/keys.js"

let db: Db
let app: FastifyInstance
let bus: EventBus
let ctx: AppContext

beforeAll(async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-app-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-app-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	bus = new EventBus()
	const secret = Buffer.from("test-secret-0123456789abcdef0123456789abcdef")
	const feedback = new Feedback()
	const log = () => {}
	const registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		(providerId) => {
			const enc = providerApiKeyEnc(db, providerId)
			if (!enc) {
				return undefined
			}
			try {
				return decryptString(enc, secret)
			} catch {
				return undefined
			}
		},
	)
	const engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
	ctx = {
		db,
		bus,
		registry,
		engine,
		feedback,
		secret,
		workspaceDir,
		reposDir: fs.mkdtempSync(path.join(os.tmpdir(), "diriz-repos-")),
	}
	app = await buildApp(ctx)
})

afterAll(async () => {
	await app.close().catch(() => {
		/* Der SSE-Test schließt die App bereits selbst. */
	})
	db.close()
})

describe("api: Health & Metriken", () => {
	it("GET /api/health → ok", async () => {
		const res = await app.inject({ method: "GET", url: "/api/health" })
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.ok).toBe(true)
	})

	it("GET /api/metrics → Summary", async () => {
		const res = await app.inject({ method: "GET", url: "/api/metrics" })
		expect(res.statusCode).toBe(200)
		expect(res.json().executions).toBeGreaterThanOrEqual(0)
	})

	it("GET /api/host/metrics → RAM/CPU (M8)", async () => {
		const res = await app.inject({ method: "GET", url: "/api/host/metrics" })
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.ramTotalBytes).toBeGreaterThan(0)
		expect(body.ramUsagePct).toBeGreaterThanOrEqual(0)
		expect(body.ramUsagePct).toBeLessThanOrEqual(100)
		expect(body.cpuCores).toBeGreaterThan(0)
		expect(typeof body.uptimeSec).toBe("number")
	})
})

describe("api: Provider CRUD", () => {
	it("POST → 201, GET → listet, PATCH → ändert, DELETE → 204", async () => {
		const created = await app.inject({
			method: "POST",
			url: "/api/providers",
			payload: { type: "ollama", label: "API Ollama", baseUrl: "http://127.0.0.1:11434" },
		})
		expect(created.statusCode).toBe(201)
		const provider = created.json()
		expect(provider.hasApiKey).toBe(false)

		const list = await app.inject({ method: "GET", url: "/api/providers" })
		expect(list.json().some((p: { id: string }) => p.id === provider.id)).toBe(true)

		const patched = await app.inject({
			method: "PATCH",
			url: `/api/providers/${provider.id}`,
			payload: { label: "API Ollama 2" },
		})
		expect(patched.statusCode).toBe(200)
		expect(patched.json().label).toBe("API Ollama 2")

		const deleted = await app.inject({ method: "DELETE", url: `/api/providers/${provider.id}` })
		expect(deleted.statusCode).toBe(204)
	})

	it("POST mit ungültigem Typ → 400", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/providers",
			payload: { type: "bogus", baseUrl: "http://x" },
		})
		expect(res.statusCode).toBe(400)
	})

	it("POST mit API-Key → Key nie im Klartext sichtbar", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/providers",
			payload: {
				type: "openrouter",
				label: "OR",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "sk-super-geheim",
			},
		})
		expect(res.statusCode).toBe(201)
		const body = res.json()
		expect(body.hasApiKey).toBe(true)
		expect(JSON.stringify(body)).not.toContain("sk-super-geheim")
		const id = body.id as string
		await app.inject({ method: "DELETE", url: `/api/providers/${id}` })
	})
})

describe("api: Tasks", () => {
	it("POST → 201 (task.created-Event), GET → Details, Start → 202", async () => {
		const events: CoreEvent[] = []
		const unsub = bus.subscribe((e) => events.push(e))
		const res = await app.inject({
			method: "POST",
			url: "/api/tasks",
			payload: { prompt: "Test-Prompt", title: "API Task" },
		})
		expect(res.statusCode).toBe(201)
		const task = res.json()
		expect(task.status).toBe("draft")
		expect(events.some((e) => e.event === "task.created")).toBe(true)
		unsub()

		const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })
		expect(detail.statusCode).toBe(200)
		expect(detail.json().executions).toEqual([])

		const start = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` })
		// 202 (angenommen) — die Ausführung scheitert asynchron, weil keine
		// Instanz existiert; die API antwortet aber akzeptierend.
		expect(start.statusCode).toBe(202)
	})

	it("POST ohne Prompt → 400", async () => {
		const res = await app.inject({ method: "POST", url: "/api/tasks", payload: {} })
		expect(res.statusCode).toBe(400)
	})

	it("GET für unbekannte Task → 404", async () => {
		const res = await app.inject({ method: "GET", url: "/api/tasks/does-not-exist" })
		expect(res.statusCode).toBe(404)
	})
})

describe("api: Vision-Anhänge (T1-2)", () => {
	/** Kleinstes gültiges PNG (1×1, transparent) als Base64. */
	const tinyPngB64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

	it("POST mit Anhang → 201, Detail zeigt dataUri, Chat-Turn trägt Thumbnails", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/tasks",
			payload: {
				prompt: "Was steht auf dem Bild?",
				attachments: [{ filename: "pixel.png", mime: "image/png", dataB64: tinyPngB64 }],
			},
		})
		expect(res.statusCode).toBe(201)
		const task = res.json()

		const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })
		expect(detail.statusCode).toBe(200)
		const atts = detail.json().attachments as { filename: string; dataUri: string }[]
		expect(atts).toHaveLength(1)
		expect(atts[0].filename).toBe("pixel.png")
		expect(atts[0].dataUri).toBe(`data:image/png;base64,${tinyPngB64}`)

		// Chat-Turn: dieselben Thumbnails, damit die Oberfläche nach dem
		// Neuladen die Bilder über der Nachricht zeigt.
		const chatRes = await app.inject({
			method: "POST",
			url: "/api/tasks",
			payload: { prompt: "Bild-Chat", metadata: { chatId: "vision-chat-1" } },
		})
		expect(chatRes.statusCode).toBe(201)
		const chatTask = chatRes.json()
		// Anhang nachträglich verknüpfen (so wie die UI ihn beim Anlegen schickt).
		db.prepare(
			"INSERT INTO attachments (id, task_id, filename, mime, size_bytes, data_b64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			crypto.randomUUID(),
			chatTask.id,
			"pixel.png",
			"image/png",
			tinyPngB64.length,
			tinyPngB64,
			new Date().toISOString(),
		)
		const chats = await app.inject({ method: "GET", url: "/api/chats?chatId=vision-chat-1" })
		expect(chats.statusCode).toBe(200)
		const turn = chats.json()[0].turns.at(-1) as { attachments: { dataUri: string }[] }
		expect(turn.attachments).toHaveLength(1)
		expect(turn.attachments[0].dataUri).toBe(`data:image/png;base64,${tinyPngB64}`)
	})

	it("POST ohne Anhang → leere attachments-Liste im Detail", async () => {
		const res = await app.inject({ method: "POST", url: "/api/tasks", payload: { prompt: "nur Text" } })
		expect(res.statusCode).toBe(201)
		const detail = await app.inject({ method: "GET", url: `/api/tasks/${res.json().id}` })
		expect(detail.json().attachments).toEqual([])
	})

	it("POST mit 6 Anhängen → 400", async () => {
		const payload = {
			prompt: "zu viele Bilder",
			attachments: Array.from({ length: 6 }, (_, i) => ({
				filename: `b${i}.png`,
				mime: "image/png",
				dataB64: tinyPngB64,
			})),
		}
		const res = await app.inject({ method: "POST", url: "/api/tasks", payload })
		expect(res.statusCode).toBe(400)
	})
})

describe("api: A/B-Vergleich (T1-1)", () => {
	/** Provider + zwei Instanzen für das Duell anlegen. */
	const makeInstances = () => {
		const provider = createProvider(db, {
			type: "ollama",
			label: "Vergleich-Ollama",
			baseUrl: "http://127.0.0.1:11500",
		})
		const a = upsertInstance(
			db,
			provider.id,
			{ modelId: "duell-a", displayName: "Duell A", contextWindow: 32768 },
			"manual",
		)
		const b = upsertInstance(
			db,
			provider.id,
			{ modelId: "duell-b", displayName: "Duell B", contextWindow: 32768 },
			"manual",
		)
		return { provider, a, b }
	}

	it("weist zu wenige, zu viele und doppelte Instanzen ab", async () => {
		const { a } = makeInstances()
		// Nur eine Instanz.
		const one = await app.inject({
			method: "POST",
			url: "/api/compare",
			payload: { prompt: "Hallo", instanceIds: [a.id] },
		})
		expect(one.statusCode).toBe(400)
		// Fünf Instanzen.
		const many = await app.inject({
			method: "POST",
			url: "/api/compare",
			payload: { prompt: "Hallo", instanceIds: ["i1", "i2", "i3", "i4", "i5"] },
		})
		expect(many.statusCode).toBe(400)
		// Doppelte Instanz.
		const dup = await app.inject({
			method: "POST",
			url: "/api/compare",
			payload: { prompt: "Hallo", instanceIds: [a.id, a.id] },
		})
		expect(dup.statusCode).toBe(400)
		// Kein Prompt.
		const noPrompt = await app.inject({
			method: "POST",
			url: "/api/compare",
			payload: { instanceIds: [a.id, a.id] },
		})
		expect(noPrompt.statusCode).toBe(400)
	})

	it("legt je Instanz eine gepinnte Task an, verbindet sie per compareId und listet das Ergebnis", async () => {
		const { a, b } = makeInstances()
		const chatId = crypto.randomUUID()
		const created = await app.inject({
			method: "POST",
			url: "/api/compare",
			payload: { prompt: "Vergleiche uns", title: "Testduell", instanceIds: [a.id, b.id], chatId },
		})
		expect(created.statusCode).toBe(201)
		const body = created.json() as {
			compareId: string
			tasks: { taskId: string; instanceId: string; started: boolean }[]
		}
		expect(body.tasks).toHaveLength(2)
		expect(new Set(body.tasks.map((t) => t.instanceId)).size).toBe(2)

		const members = listCompareTasks(db, body.compareId)
		expect(members).toHaveLength(2)
		for (const m of members) {
			expect(m.metadata.compareId).toBe(body.compareId)
			expect(m.metadata.mode).toBe("pinned")
			expect(m.metadata.privacy).toBe("local-only")
			expect(m.metadata.chatId).toBe(chatId)
			expect(m.prompt).toBe("Vergleiche uns")
		}

		// Ergebnis-Endpunkt: Die Executions entstehen asynchron im Engine-Lauf —
		// der Provider ist offline, also kippen die Tasks rasch auf „failed"
		// mit einem Execution-Record. Bis dahin darf das Modell noch „—" sein.
		const deadline = Date.now() + 2000
		let result = await app.inject({ method: "GET", url: `/api/compare/${body.compareId}` })
		while (
			Date.now() < deadline &&
			(result.json() as { members: { modelName: string }[] }).members.some((m) => m.modelName === "—")
		) {
			await new Promise((r) => setTimeout(r, 50))
			result = await app.inject({ method: "GET", url: `/api/compare/${body.compareId}` })
		}
		expect(result.statusCode).toBe(200)
		const view = result.json() as {
			compareId: string
			prompt: string
			members: { taskId: string; modelName: string; status: string }[]
			allFinished: boolean
		}
		expect(view.compareId).toBe(body.compareId)
		expect(view.prompt).toBe("Vergleiche uns")
		expect(view.members).toHaveLength(2)
		expect(new Set(view.members.map((m) => m.taskId)).size).toBe(2)
		// Ohne Execution (Provider offline, Routing abgelehnt) bleibt das
		// Modell „—"; mit Execution steht der DisplayName. Beides ist gültig.
		expect(
			view.members.every((m) => m.modelName === "—" || ["Duell A", "Duell B"].includes(m.modelName)),
		).toBe(true)

		// Recent-Liste enthält das frische Duell.
		const recent = await app.inject({ method: "GET", url: "/api/compare/recent?limit=5" })
		expect(recent.statusCode).toBe(200)
		const rows = recent.json() as { compareId: string }[]
		expect(rows.some((r) => r.compareId === body.compareId)).toBe(true)
	})

	it("meldet ein unbekanntes Duell als 404", async () => {
		const res = await app.inject({ method: "GET", url: "/api/compare/nein-da-nicht" })
		expect(res.statusCode).toBe(404)
	})
})

describe("api: Team-Katalog", () => {
	it("meldet, welche Katalog-Spezialisten fehlen, und legt sie an", async () => {
		const before = await app.inject({ method: "GET", url: "/api/agents/catalog" })
		expect(before.statusCode).toBe(200)
		const catalog = before.json() as { agents: { slug: string; installed: boolean }[] }
		expect(catalog.agents.length).toBe(SOFTWARE_TEAM.length)
		expect(catalog.agents.every((a) => !a.installed)).toBe(true)

		const seeded = await app.inject({ method: "POST", url: "/api/agents/catalog" })
		expect(seeded.statusCode).toBe(201)
		expect((seeded.json() as { agents: string[] }).agents.length).toBe(catalog.agents.length)

		const after = (await app.inject({ method: "GET", url: "/api/agents/catalog" })).json() as {
			agents: { installed: boolean }[]
		}
		expect(after.agents.every((a) => a.installed)).toBe(true)

		// Zweiter Aufruf legt nichts erneut an.
		const again = await app.inject({ method: "POST", url: "/api/agents/catalog" })
		expect((again.json() as { agents: string[] }).agents).toEqual([])
	})
})

describe("api: Settings, Export & Import", () => {
	it("GET /api/settings liefert renormierte Defaults (Summe 1)", async () => {
		const res = await app.inject({ method: "GET", url: "/api/settings" })
		expect(res.statusCode).toBe(200)
		const w = res.json().routingWeights
		const sum = Object.values(w).reduce((a: number, b) => a + (b as number), 0)
		expect(sum).toBeCloseTo(1)
	})

	it("PUT /api/settings validiert und persistiert", async () => {
		const bad = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { routingWeights: { contextFit: 2 } },
		})
		expect(bad.statusCode).toBe(400)

		const good = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: {
				routingWeights: {
					contextFit: 0.5,
					capabilityMatch: 0.3,
					qualityPrior: 0.1,
					loadScore: 0.04,
					costScore: 0.04,
					latencyScore: 0.02,
				},
			},
		})
		expect(good.statusCode).toBe(200)

		const after = await app.inject({ method: "GET", url: "/api/settings" })
		expect(after.json().routingWeights.contextFit).toBeCloseTo(0.5)
	})

	it("Export liefert Dokument, Import upsertet Agenten per Name", async () => {
		const exportRes = await app.inject({ method: "GET", url: "/api/export" })
		expect(exportRes.statusCode).toBe(200)
		const exp = exportRes.json()
		expect(exp.format).toBe("diriz-export")
		expect(Array.isArray(exp.tasks)).toBe(true)

		const badImport = await app.inject({ method: "POST", url: "/api/import", payload: { format: "wrong" } })
		expect(badImport.statusCode).toBe(400)

		const importRes = await app.inject({
			method: "POST",
			url: "/api/import",
			payload: {
				format: "diriz-export",
				agents: [{ name: "Test-Agent", description: "Import-Test" }],
				swarms: [],
				templates: [],
			},
		})
		expect(importRes.statusCode).toBe(200)
		expect(importRes.json().imported).toBeGreaterThanOrEqual(1)

		const agents = await app.inject({ method: "GET", url: "/api/agents" })
		expect(agents.json().some((a: { name: string }) => a.name === "Test-Agent")).toBe(true)
	})
})

describe("api: Theme (T2-7)", () => {
	it("liefert Dark als Default und akzeptiert den Wechsel auf Light", async () => {
		const defaults = await app.inject({ method: "GET", url: "/api/settings" })
		expect(defaults.statusCode).toBe(200)
		expect(defaults.json().theme).toBe("dark")

		const light = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { theme: "light" },
		})
		expect(light.statusCode).toBe(200)
		expect(light.json().theme).toBe("light")

		const back = await app.inject({ method: "GET", url: "/api/settings" })
		expect(back.json().theme).toBe("light")
	})

	it("lehnt jeden anderen Theme-Wert ab (400)", async () => {
		const bad = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { theme: "neon" },
		})
		expect(bad.statusCode).toBe(400)
	})
})

describe("api: Version", () => {
	it("meldet, wann der laufende Code gebaut wurde", async () => {
		const res = await app.inject({ method: "GET", url: "/api/version" })
		expect(res.statusCode).toBe(200)
		const body = res.json() as { builtAt?: string; startedAt: string }
		// Ohne diesen Zeitstempel bliebe ein weiterlaufender alter Prozess
		// unsichtbar — er meldet dieselbe Versionsnummer wie der neue.
		expect(body.builtAt).toBeTypeOf("string")
		expect(Number.isNaN(Date.parse(body.builtAt ?? ""))).toBe(false)
	})
})

describe("api: Swarm-Planung", () => {
	it("stellt für einen mehrteiligen Auftrag eine Kette entlang des Wertstroms zusammen", async () => {
		await app.inject({ method: "POST", url: "/api/agents/catalog" })
		const res = await app.inject({
			method: "POST",
			url: "/api/swarms/plan",
			payload: {
				prompt: "Entwirf die REST-API, implementiere den Endpoint im Backend und prüfe ihn auf SQL-Injection",
			},
		})
		expect(res.statusCode).toBe(200)
		const steps = (res.json() as { steps: { agentId: string; discipline?: string }[] }).steps
		expect(steps.length).toBeGreaterThan(1)
		// Entwurf vor Umsetzung vor Prüfung — nicht nach Punktzahl sortiert.
		const bereiche = steps.map((s) => s.discipline)
		expect(bereiche.indexOf("Architektur & Design")).toBeLessThan(bereiche.indexOf("Qualität"))
		expect(new Set(bereiche).size).toBe(bereiche.length)
	})

	it("weist einen leeren Prompt ab", async () => {
		const res = await app.inject({ method: "POST", url: "/api/swarms/plan", payload: { prompt: "  " } })
		expect(res.statusCode).toBe(400)
	})
})

describe("api: Chat-Verlauf", () => {
	it("gruppiert Chat-Nachrichten zu Gesprächen — der Verlauf lebt in der Datenbank", async () => {
		const chatId = "chat-test-1"
		for (const prompt of ["Erste Frage", "Zweite Frage"]) {
			const res = await app.inject({
				method: "POST",
				url: "/api/tasks",
				payload: { title: prompt, prompt, metadata: { chatId, privacy: "local-only" } },
			})
			expect(res.statusCode).toBe(201)
		}
		// Eine Task ohne chatId gehört zu keinem Gespräch.
		await app.inject({ method: "POST", url: "/api/tasks", payload: { prompt: "Ohne Chat" } })

		const res = await app.inject({ method: "GET", url: "/api/chats" })
		expect(res.statusCode).toBe(200)
		const chats = res.json() as { chatId: string; title: string; turns: { prompt: string }[] }[]
		const chat = chats.find((c) => c.chatId === chatId)
		expect(chat).toBeDefined()
		expect(chat?.title).toBe("Erste Frage")
		// Innerhalb eines Gesprächs chronologisch — sonst läse es sich rückwärts.
		expect(chat?.turns.map((t) => t.prompt)).toEqual(["Erste Frage", "Zweite Frage"])
		expect(chats.every((c) => c.chatId)).toBe(true)
	})

	it("filtert auf ein einzelnes Gespräch", async () => {
		const res = await app.inject({ method: "GET", url: "/api/chats?chatId=chat-test-1" })
		const chats = res.json() as { chatId: string }[]
		expect(chats.map((c) => c.chatId)).toEqual(["chat-test-1"])
	})

	it("löscht ein Gespräch samt allen Nachrichten", async () => {
		const chatId = "chat-zum-loeschen"
		for (const prompt of ["A", "B"]) {
			await app.inject({
				method: "POST",
				url: "/api/tasks",
				payload: { prompt, metadata: { chatId } },
			})
		}
		const del = await app.inject({ method: "DELETE", url: `/api/chats/${chatId}` })
		expect(del.statusCode).toBe(200)
		expect(del.json()).toEqual({ deleted: 2 })

		const rest = await app.inject({ method: "GET", url: `/api/chats?chatId=${chatId}` })
		expect(rest.json()).toEqual([])
		// Andere Gespräche bleiben unberührt.
		const alle = (await app.inject({ method: "GET", url: "/api/chats" })).json() as { chatId: string }[]
		expect(alle.some((c) => c.chatId === "chat-test-1")).toBe(true)
	})

	it("meldet ein unbekanntes Gespräch als 404", async () => {
		const res = await app.inject({ method: "DELETE", url: "/api/chats/gibt-es-nicht" })
		expect(res.statusCode).toBe(404)
	})
})

describe("api: Parallelitäts- und GPU-Grenzen", () => {
	it("liefert Vorgaben und speichert geänderte Grenzen", async () => {
		const before = await app.inject({ method: "GET", url: "/api/settings" })
		expect(before.json().concurrency).toEqual({ global: 4, perProvider: 2, maxModelsPerProvider: 1 })

		// Teil-Update: Nur eine Zahl ändern, der Rest bleibt stehen.
		const saved = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { concurrency: { maxModelsPerProvider: 2 } },
		})
		expect(saved.statusCode).toBe(200)
		expect(saved.json().concurrency).toEqual({ global: 4, perProvider: 2, maxModelsPerProvider: 2 })

		// Und die Engine liest denselben Wert — sonst wäre die Einstellung Zierde.
		expect(ctx.engine.limits().maxModelsPerProvider).toBe(2)

		await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { concurrency: { maxModelsPerProvider: 1 } },
		})
	})

	it("liefert und speichert Zeitgrenzen; Agentik bekommt die dreifache Gesamtdauer", async () => {
		const before = (await app.inject({ method: "GET", url: "/api/settings" })).json()
		expect(before.timeouts.totalMs).toBeGreaterThan(0)

		const saved = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { timeouts: { totalMs: 1_800_000 } },
		})
		expect(saved.statusCode).toBe(200)
		expect(saved.json().timeouts.totalMs).toBe(1_800_000)
		// Ein Agentik-Lauf liest Dateien, denkt nach und antwortet in Schritten —
		// mit derselben Frist scheitert er regelmässig kurz vor dem Ziel.
		expect(ctx.engine.timeouts(true).totalMs).toBe(5_400_000)
		expect(ctx.engine.timeouts(false).totalMs).toBe(1_800_000)
	})

	it("erlaubt ein unbegrenztes Tool-Budget (0) und weist Unsinn ab", async () => {
		const before = (await app.inject({ method: "GET", url: "/api/settings" })).json()
		expect(before.agent).toEqual({ maxSteps: 0 })

		const saved = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { agent: { maxSteps: 50 } },
		})
		expect(saved.json().agent.maxSteps).toBe(50)
		expect(ctx.engine.agentSettings().maxSteps).toBe(50)

		// 0 heisst ausdrücklich „unbegrenzt" und ist kein Fehler.
		const zurueck = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { agent: { maxSteps: 0 } },
		})
		expect(zurueck.json().agent.maxSteps).toBe(0)

		const falsch = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { agent: { maxSteps: -3 } },
		})
		expect(falsch.statusCode).toBe(400)
	})

	it("weist zu kurze Zeitgrenzen ab", async () => {
		const res = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { timeouts: { totalMs: 100 } },
		})
		expect(res.statusCode).toBe(400)
	})

	it("weist unsinnige Grenzen ab", async () => {
		for (const concurrency of [{ global: 0 }, { perProvider: 1.5 }, { maxModelsPerProvider: -1 }]) {
			const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { concurrency } })
			expect(res.statusCode, JSON.stringify(concurrency)).toBe(400)
		}
	})
})

describe("api: Abgebrochenen Lauf fortsetzen", () => {
	it("legt eine Folge-Task mit Vorarbeit und gemeinsamem Arbeitsverzeichnis an", async () => {
		const angelegt = await app.inject({
			method: "POST",
			url: "/api/tasks",
			payload: { title: "Abgebrochen", prompt: "Mach etwas Grosses" },
		})
		expect(angelegt.statusCode).toBe(201)
		const taskId = angelegt.json().id as string

		const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/resume` })
		expect(res.statusCode).toBe(202)
		const folgeId = res.json().taskId as string
		expect(folgeId).not.toBe(taskId)

		const folge = await app.inject({ method: "GET", url: `/api/tasks/${folgeId}` })
		const body = folge.json()
		expect(body.prompt).toContain("## Ursprünglicher Auftrag")
		expect(body.prompt).toContain("Mach etwas Grosses")
		expect(body.prompt).toContain("## Bisheriger Stand")
		// Dasselbe Arbeitsverzeichnis wie der abgebrochene Lauf.
		expect(body.metadata.chain.rootTaskId).toBe(taskId)
	})

	it("weist eine unbekannte Task ab", async () => {
		const res = await app.inject({ method: "POST", url: "/api/tasks/gibt-es-nicht/resume" })
		expect(res.statusCode).toBe(404)
	})
})

describe("api: Aufbewahrung & Warmhalten", () => {
	it("liefert Vorgaben und nimmt neue Fristen an", async () => {
		const vorher = await app.inject({ method: "GET", url: "/api/settings" })
		expect(vorher.json().retention).toEqual({ logDays: 14, chunkDays: 30, metricsDays: 180 })
		expect(vorher.json().warmup).toEqual({ enabled: true, intervalMinutes: 4, perProvider: 1 })

		const put = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { retention: { logDays: 7 } },
		})
		expect(put.statusCode).toBe(200)
		// Nur das gesetzte Feld ändert sich, die übrigen bleiben.
		expect(put.json().retention).toEqual({ logDays: 7, chunkDays: 30, metricsDays: 180 })
	})

	it("weist unsinnige Fristen ab, statt sie stillschweigend zu übernehmen", async () => {
		const res = await app.inject({
			method: "PUT",
			url: "/api/settings",
			payload: { retention: { logDays: 0 } },
		})
		expect(res.statusCode).toBe(400)
	})
})

describe("api: SSE-Stream", () => {
	it("liefert Events über den echten HTTP-Stream", async () => {
		await app.listen({ port: 0, host: "127.0.0.1" })
		const address = app.server.address()
		const port = typeof address === "object" && address !== null ? address.port : 0
		expect(port).toBeGreaterThan(0)
		const res = await fetch(`http://127.0.0.1:${port}/api/stream`)
		expect(res.headers.get("content-type")).toContain("text/event-stream")
		const reader = res.body?.getReader()
		expect(reader).toBeTruthy()
		const streamReader = reader as ReadableStreamDefaultReader<Uint8Array>

		// Event auslösen, während der Stream offen ist.
		await new Promise((r) => setTimeout(r, 50))
		bus.emit({ event: "task.created", data: { taskId: "sse-test" } })
		await new Promise((r) => setTimeout(r, 50))

		const result = await streamReader.read()
		const text = new TextDecoder().decode(result.value ?? new Uint8Array())
		expect(text).toContain("event: task.created")
		expect(text).toContain('"taskId":"sse-test"')

		if (reader) {
			await reader.cancel().catch(() => {
				/* Stream wurde bereits beendet. */
			})
		}
		await app.close()
	})
})

/**
 * Fortsetzen: Ein abgebrochener Lauf ist kein verlorener Lauf. Die neue Task
 * trägt den bisherigen Stand als Vorarbeit **und** arbeitet im selben
 * Verzeichnis — sonst begänne sie wieder bei null.
 */

describe("API: Provider zeigen ihre Rechner", () => {
	it("nennt die Geräte, auf denen die Modelle wirklich rechnen", async () => {
		// `MacDani` ist ein Mac, der über LM Link die Modelle eines
		// Windows-Rechners durchreicht: Zwei Modelle laufen hier, eines dort.
		const app = await buildApp(ctx)
		const mac = createProvider(ctx.db, {
			type: "lmstudio",
			label: "MacDani",
			baseUrl: "http://127.0.0.1:1234",
		})
		upsertInstance(
			ctx.db,
			mac.id,
			{ modelId: "eigen", displayName: "eigen", contextWindow: 8192, deviceName: "MacBook-Pro" },
			"discovered",
		)
		upsertInstance(
			ctx.db,
			mac.id,
			{ modelId: "fremd", displayName: "fremd", contextWindow: 8192, deviceName: "LokalAI_Server1" },
			"discovered",
		)

		const res = await app.inject({ method: "GET", url: "/api/providers" })
		const liste = res.json() as { label: string; devices?: string[] }[]
		const eintrag = liste.find((p) => p.label === "MacDani")
		expect(eintrag?.devices).toContain("MacBook-Pro")
		expect(eintrag?.devices).toContain("LokalAI_Server1")
		await app.close()
	})
})

describe("API: Rechner eines Zugangs erklären", () => {
	it("nimmt den Rechnernamen entgegen und gibt ihn zurück", async () => {
		// Über einen Tunnel kann DiriZ das Gerät nicht messen — der Mensch sagt
		// es. Zwei Zugänge mit demselben Rechnernamen teilen sich eine Karte.
		const app = await buildApp(ctx)
		const tunnel = createProvider(ctx.db, {
			type: "lmstudio",
			label: "lokalai",
			baseUrl: "https://lokalai.ngrok.dev/v1",
		})
		const res = await app.inject({
			method: "PATCH",
			url: `/api/providers/${tunnel.id}`,
			payload: { deviceName: "LokalAI_Server1" },
		})
		expect(res.statusCode).toBe(200)

		const liste = (await app.inject({ method: "GET", url: "/api/providers" })).json() as {
			label: string
			devices?: string[]
		}[]
		expect(liste.find((p) => p.label === "lokalai")?.devices).toContain("LokalAI_Server1")

		// Leer = wieder vergessen.
		await app.inject({ method: "PATCH", url: `/api/providers/${tunnel.id}`, payload: { deviceName: "" } })
		const danach = (await app.inject({ method: "GET", url: "/api/providers" })).json() as {
			label: string
			devices?: string[]
		}[]
		expect(danach.find((p) => p.label === "lokalai")?.devices ?? []).toHaveLength(0)
		await app.close()
	})
})

describe("API: Adresse eines Cloud-Providers", () => {
	it("speichert die offizielle Adresse, wenn eine lokale angegeben wurde", async () => {
		// Der echte Fall: Die Maske gab `http://localhost:11434` vor und schickte
		// den Wert auch für OpenRouter mit — in der Datenbank stand ein Eintrag,
		// der gültig aussah und nie funktionieren konnte.
		const app = await buildApp(ctx)
		const res = await app.inject({
			method: "POST",
			url: "/api/providers",
			payload: { type: "openrouter", label: "OR", baseUrl: "http://localhost:11434", apiKey: "sk-test" },
		})
		expect(res.statusCode).toBe(201)
		expect(res.json().baseUrl).toBe("https://openrouter.ai/api/v1")
		await app.close()
	})

	it("lässt einen eigenen Proxy stehen", async () => {
		const app = await buildApp(ctx)
		const res = await app.inject({
			method: "POST",
			url: "/api/providers",
			payload: {
				type: "openrouter",
				label: "OR-Proxy",
				baseUrl: "https://proxy.firma.example/v1",
				apiKey: "sk-test",
			},
		})
		expect(res.json().baseUrl).toBe("https://proxy.firma.example/v1")
		await app.close()
	})
})

describe("API: Modelle eines Rechners auf einmal schalten", () => {
	it("schaltet alle ab und wieder an — in einer Anfrage", async () => {
		// Ein OpenRouter-Zugang bringt 417 Modelle mit. Einzeln abzuwählen sind
		// das vierhundert Klicks und vierhundert Anfragen.
		const app = await buildApp(ctx)
		const p = createProvider(ctx.db, { type: "lmstudio", label: "Viele", baseUrl: "http://x:1234" })
		for (const m of ["a", "b", "c"]) {
			upsertInstance(ctx.db, p.id, { modelId: m, displayName: m, contextWindow: 8192 }, "discovered")
		}

		const aus = await app.inject({
			method: "POST",
			url: `/api/providers/${p.id}/instances/enabled`,
			payload: { enabled: false },
		})
		expect(aus.statusCode).toBe(200)
		expect(aus.json().changed).toBe(3)
		expect(listInstances(ctx.db, p.id).every((i) => i.enabled === false)).toBe(true)

		// Zweiter Aufruf ändert nichts mehr — gezählt wird, was wirklich geschah.
		const nochmal = await app.inject({
			method: "POST",
			url: `/api/providers/${p.id}/instances/enabled`,
			payload: { enabled: false },
		})
		expect(nochmal.json().changed).toBe(0)

		const an = await app.inject({
			method: "POST",
			url: `/api/providers/${p.id}/instances/enabled`,
			payload: { enabled: true },
		})
		expect(an.json().changed).toBe(3)
		expect(listInstances(ctx.db, p.id).every((i) => i.enabled)).toBe(true)
		await app.close()
	})
})
