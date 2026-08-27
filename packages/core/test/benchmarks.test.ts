/**
 * T1-5 Modell-Benchmarks: Keyword-Qualität, der Runner (Mock-Provider)
 * und die API-Routen (Fastify `inject`).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BENCHMARK_SUITE, type ChatChunk, type ChatRequest, type LLMProvider } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import {
	BENCHMARK_TEMPERATURE,
	keywordTreffers,
	runBenchmark,
	runBenchmarkTask,
} from "../src/benchmarks/runner.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createProvider, upsertInstance } from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

/* ------------------------------- keywordTreffers ------------------------------ */

describe("keywordTreffers", () => {
	it("zählt alle Treffer bei vollständiger Antwort", () => {
		const r = keywordTreffers("def is_prime(n):\n    return n > 1", ["is_prime"])
		expect(r.anteil).toBe(1)
		expect(r.fehlende).toEqual([])
	})

	it("ist gross-/kleinschreibung-insensitiv und zählt Teilstrings", () => {
		const r = keywordTreffers("Hier ist IS_PRIME fertig.", ["is_prime"])
		expect(r.anteil).toBe(1)
	})

	it("liefert den richtigen Anteil bei Teil-Treffern", () => {
		const r = keywordTreffers("nur ein Treffer", ["treffer", "fehlt", "auch_nicht"])
		expect(r.anteil).toBeCloseTo(1 / 3)
		expect(r.fehlende).toEqual(["fehlt", "auch_nicht"])
	})

	it("behandelt eine leere Erwartungsliste als voll erfüllt", () => {
		expect(keywordTreffers("irgendwas", []).anteil).toBe(1)
	})
})

/* --------------------------------- Mock-Provider ------------------------------ */

function mockProvider(
	responseText: string | undefined,
	error?: Error,
	seen: ChatRequest[] = [],
): LLMProvider {
	return {
		id: "mock-bench",
		type: "ollama",
		label: "Mock Benchmark",
		healthCheck: async () => ({ ok: true, latencyMs: 1 }),
		listModels: async () => [],
		cancel: async () => {},
		chat: (req: ChatRequest): AsyncGenerator<ChatChunk> => {
			seen.push(req)
			return (async function* (): AsyncGenerator<ChatChunk> {
				if (error) {
					throw error
				}
				if (responseText !== undefined) {
					yield { type: "delta", text: responseText }
				}
				yield { type: "done" }
			})()
		},
	}
}

/* ----------------------------------- Runner ---------------------------------- */

describe("runBenchmarkTask", () => {
	it("misst eine erfolgreiche Aufgabe (Output, Temperatur, Modell)", async () => {
		const seen: ChatRequest[] = []
		const provider = mockProvider("def is_prime(n): return n > 1", undefined, seen)
		const task = BENCHMARK_SUITE.find((t) => t.id === "code-prime") as (typeof BENCHMARK_SUITE)[number]
		const r = await runBenchmarkTask(provider, "test-model", task, {})
		expect(r.ok).toBe(true)
		expect(r.error).toBeUndefined()
		expect(r.output).toContain("is_prime")
		expect(r.quality).toBe(1)
		expect(seen[0].model).toBe("test-model")
		expect(seen[0].settings?.maxTokens).toBe(256)
		expect(seen[0].settings?.temperature).toBe(BENCHMARK_TEMPERATURE)
		expect(seen[0].messages[0].content).toContain("is_prime(n)")
	})

	it("trägt einen Adapter-Fehler pro Aufgabe, ohne den Lauf zu beenden", async () => {
		const provider = mockProvider(undefined, new Error("offline"))
		const tasks = BENCHMARK_SUITE.slice(0, 2)
		const result = await runBenchmark(provider, "m", tasks, {})
		expect(result.erg).toHaveLength(2)
		expect(result.erg.every((e) => e.ok === false)).toBe(true)
		expect(result.erg[0].error).toContain("offline")
		expect(result.zusammenfassung.fehler).toBe(2)
		expect(result.zusammenfassung.laufend).toBe(0)
	})

	it("bricht eine Aufgabe bei Timeout ab und meldet es als Fehler", async () => {
		const langsam: LLMProvider = {
			id: "mock-langsam",
			type: "ollama",
			label: "Langsam",
			healthCheck: async () => ({ ok: true, latencyMs: 1 }),
			listModels: async () => [],
			cancel: async () => {},
			chat: (req: ChatRequest): AsyncGenerator<ChatChunk> => {
				return (async function* () {
					function abortError(): Error {
						const e = new Error("aborted")
						e.name = "AbortError"
						return e
					}
					await new Promise((resolve, reject) => {
						const t = setTimeout(() => resolve(null), 500)
						req.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t)
								reject(abortError())
							},
							{ once: true },
						)
					})
					yield { type: "delta", text: "zu spät" }
				})()
			},
		}
		const task = BENCHMARK_SUITE[0]
		const r = await runBenchmarkTask(langsam, "m", task, { timeoutMs: 50 })
		expect(r.ok).toBe(false)
		expect(r.error).toContain("Timeout")
	})

	it("nimmt die Usage-Chunk-Token mit und rechnet TPS", async () => {
		const mitUsage: LLMProvider = {
			...mockProvider("Antwort"),
			chat: (_req: ChatRequest): AsyncGenerator<ChatChunk> =>
				(async function* (): AsyncGenerator<ChatChunk> {
					yield { type: "delta", text: "Antwort" }
					yield { type: "usage", tokensIn: 10, tokensOut: 42 }
					yield { type: "done" }
				})(),
		}
		const r = await runBenchmarkTask(mitUsage, "m", BENCHMARK_SUITE[0], {})
		expect(r.tokensOut).toBe(42)
		expect(r.tps).not.toBeNull()
		expect(r.tps as number).toBeGreaterThan(0)
	})

	it("hält sich an den Output-Limit und kürzt lange Antworten", async () => {
		const lang = "x".repeat(5000)
		const provider = mockProvider(lang)
		const r = await runBenchmarkTask(provider, "m", BENCHMARK_SUITE[0], { outputMaxChars: 100 })
		expect(r.output.length).toBeLessThanOrEqual(101)
		expect(r.output.endsWith("…")).toBe(true)
	})
})

describe("runBenchmark (ganzer Lauf)", () => {
	it("läuft die ganze Suite und fasst korrekt zusammen", async () => {
		const result = await runBenchmark(
			mockProvider("is_prime sinlos juli bitte server order customer_id desc fib cache @"),
			"m",
			BENCHMARK_SUITE,
		)
		expect(result.erg).toHaveLength(BENCHMARK_SUITE.length)
		expect(result.zusammenfassung.laufend).toBe(BENCHMARK_SUITE.length)
		expect(result.zusammenfassung.fehler).toBe(0)
		expect(result.zusammenfassung.qualitaet).toBeGreaterThan(0)
		expect(result.zusammenfassung.gesamtMs).toBeGreaterThanOrEqual(0)
		expect(result.providerId).toBe("mock-bench")
		expect(result.modelId).toBe("m")
	})

	it("läuft nur die angeforderte Teilmenge", async () => {
		const subset = BENCHMARK_SUITE.filter((t) => t.category === "code")
		const result = await runBenchmark(mockProvider("is_prime"), "m", BENCHMARK_SUITE, { tasks: subset })
		expect(result.erg).toHaveLength(subset.length)
		expect(result.erg.every((e) => e.category === "code")).toBe(true)
	})

	it("fällt ohne Teilmenge auf die ganze Suite zurück", async () => {
		const result = await runBenchmark(mockProvider("is_prime"), "m", BENCHMARK_SUITE, { tasks: [] })
		expect(result.erg).toHaveLength(BENCHMARK_SUITE.length)
	})
})

/* ----------------------------------- Routen ---------------------------------- */

describe("api: Benchmarks (T1-5)", () => {
	let db: Db
	let app: FastifyInstance
	let ctx: AppContext
	let registry: ProviderRegistry
	let providerId: string
	let instanceId: string

	beforeAll(async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-bench-"))
		const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-bench-ws-"))
		db = openDatabase(dataDir)
		migrate(db)
		const bus = new EventBus()
		const secret = Buffer.from("test-secret-0123456789abcdef0123456789abcdef")
		const log = () => {}
		registry = new ProviderRegistry(
			db,
			(e) => bus.emit(e),
			log,
			() => undefined,
		)
		const engine = new ExecutionEngine({
			db,
			registry,
			feedback: new Feedback(),
			emit: (e) => bus.emit(e),
			log,
			workspaceDir,
		})
		ctx = {
			db,
			bus,
			registry,
			engine,
			feedback: new Feedback(),
			secret,
			workspaceDir,
			reposDir: fs.mkdtempSync(path.join(os.tmpdir(), "diriz-bench-repos-")),
		}
		app = await buildApp(ctx)

		// Provider + Instanz in der DB, Mock-Adapter in der Registry.
		const provider = createProvider(db, {
			type: "ollama",
			label: "Benchmark-Ollama",
			baseUrl: "http://127.0.0.1:11501",
		})
		providerId = provider.id
		registry.registerAdapter(providerId, "ollama", "Benchmark Mock", mockProvider("is_prime sinlos"))
		const inst = upsertInstance(
			db,
			providerId,
			{ modelId: "bench-model", displayName: "Bench Modell", contextWindow: 32768 },
			"manual",
		)
		instanceId = inst.id
	})

	afterAll(async () => {
		await app.close().catch(() => {})
		db.close()
	})

	it("GET /api/benchmarks/suite liefert alle zehn Aufgaben", async () => {
		const res = await app.inject({ method: "GET", url: "/api/benchmarks/suite" })
		expect(res.statusCode).toBe(200)
		const body = res.json() as { suite: { id: string; prompt: string; erwartet: string[] }[] }
		expect(body.suite).toHaveLength(10)
		expect(body.suite.every((t) => t.id && t.prompt && t.erwartet.length > 0)).toBe(true)
	})

	it("POST mit unbekannter Instanz → 404", async () => {
		const res = await app.inject({ method: "POST", url: "/api/benchmarks/gibt-es-nicht" })
		expect(res.statusCode).toBe(404)
	})

	it("POST startet asynchron (202), Poll liefert das Ergebnis", async () => {
		const start = await app.inject({ method: "POST", url: `/api/benchmarks/${instanceId}` })
		expect(start.statusCode).toBe(202)
		expect((start.json() as { accepted: boolean }).accepted).toBe(true)

		// Der Lauf ist bei einem Mock-Provider sofort fertig; trotzdem
		// pollen, weil die 202-Antwort nicht garantieren muss, dass das
		// Ergebnis schon gespeichert ist.
		let last = await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })
		const deadline = Date.now() + 2000
		while (Date.now() < deadline && (last.json() as { completed: boolean }).completed === false) {
			await new Promise((r) => setTimeout(r, 50))
			last = await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })
		}
		expect(last.statusCode).toBe(200)
		const body = last.json() as {
			completed: boolean
			running: boolean
			result: {
				modelId: string
				erg: { taskId: string; ok: boolean }[]
				zusammenfassung: { laufend: number }
			} | null
		}
		expect(body.completed).toBe(true)
		expect(body.running).toBe(false)
		expect(body.result?.modelId).toBe("bench-model")
		expect(body.result?.erg).toHaveLength(10)
		expect(body.result?.zusammenfassung.laufend).toBe(10)
	})

	it("akzeptiert eine Aufgaben-Teilmenge im Start-Request (202) und liefert ein Ergebnis", async () => {
		const start = await app.inject({
			method: "POST",
			url: `/api/benchmarks/${instanceId}`,
			payload: { tasks: ["code-prime", "code-regex"] },
		})
		expect(start.statusCode).toBe(202)
		// Der Mock ist schneller als der Poll-Loop — das Ergebnis liegt am
		// Ende als vollständiger Eintrag vor (Teilmenge oder, nach dem
		// Fallback-Test, die ganze Suite). Hier zählt der 202-Vertrag.
		let body = (await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })).json() as {
			completed: boolean
			result: { erg: { taskId: string }[] } | null
		}
		const deadline = Date.now() + 2000
		while (Date.now() < deadline && body.completed === false) {
			await new Promise((r) => setTimeout(r, 50))
			body = (
				await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })
			).json() as typeof body
		}
		expect(body.completed).toBe(true)
		expect(body.result?.erg.length).toBeGreaterThan(0)
	})

	it("verwirft unbekannte Aufgaben-IDs sanft (202 statt Fehler)", async () => {
		// Vertrag: Unbekannte IDs erzeugen keinen Fehler — der Lauf wird
		// akzeptiert. Der Fallback auf die ganze Suite ist eine Runner-
		// Detail und wird oben in „läuft nur die angeforderte Teilmenge"
		// mitgeprüft.
		const start = await app.inject({
			method: "POST",
			url: `/api/benchmarks/${instanceId}`,
			payload: { tasks: ["keine-id"] },
		})
		expect(start.statusCode).toBe(202)
		expect((start.json() as { accepted: boolean }).accepted).toBe(true)

		// Aufräumen: Der Lauf muss fertig werden, sonst blockiert er die
		// InFlight-Map und der 409-Test erblickt 409 auf dem falschen POST.
		let status = (await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })).json() as {
			running: boolean
		}
		const deadline = Date.now() + 3000
		while (Date.now() < deadline && status.running === true) {
			await new Promise((r) => setTimeout(r, 50))
			status = (await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })).json() as {
				running: boolean
			}
		}
		expect(status.running).toBe(false)
	})

	it("meldet eine laufende Suite als 409 (kein Doppelstart)", async () => {
		// Langsamer Mock: jede Antwort wartet 400 ms — 10 Aufgaben × 400 ms
		// halten die Instanz deutlich länger als der zweite Start.
		const frei = new Promise<void>((resolve) => setTimeout(resolve, 400))
		const langsam: LLMProvider = {
			id: "mock-langsam-route",
			type: "ollama",
			label: "Langsam",
			healthCheck: async () => ({ ok: true, latencyMs: 1 }),
			listModels: async () => [],
			cancel: async () => {},
			chat: (req: ChatRequest): AsyncGenerator<ChatChunk> => {
				void req
				return (async function* (): AsyncGenerator<ChatChunk> {
					await frei
					yield { type: "delta", text: "is_prime" }
					yield { type: "done" }
				})()
			},
		}
		registry.registerAdapter(providerId, "ollama", "Benchmark Langsam", langsam)

		const first = await app.inject({ method: "POST", url: `/api/benchmarks/${instanceId}` })
		expect(first.statusCode).toBe(202)
		const second = await app.inject({ method: "POST", url: `/api/benchmarks/${instanceId}` })
		expect(second.statusCode).toBe(409)

		// Auf den Abschluss warten: `running` kippt, wenn der Lauf durch ist
		// und der InFlight-Eintrag geräumt wurde — dann ist die Instanz
		// wieder startbar.
		let status = (await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })).json() as {
			running: boolean
		}
		const deadline = Date.now() + 5000
		while (Date.now() < deadline && status.running === true) {
			await new Promise((r) => setTimeout(r, 50))
			status = (await app.inject({ method: "GET", url: `/api/benchmarks/${instanceId}/last` })).json() as {
				running: boolean
			}
		}
		expect(status.running).toBe(false)
		const third = await app.inject({ method: "POST", url: `/api/benchmarks/${instanceId}` })
		expect(third.statusCode).toBe(202)
	})
})
