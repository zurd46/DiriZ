/**
 * T1-3 Router-Modell: Parsing, der eigentliche Call (Mock-Provider) und die
 * Kaskade in `extractProfileSmart` — inklusive aller Fallback-Pfade.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatChunk, ChatRequest, LLMProvider } from "@diriz/shared"
import { beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { setSetting } from "../src/db/repositories.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { analyzePromptWithModel, parseRouterResponse, RouterTimeoutError } from "../src/routing/llmRouter.js"
import { extractProfile, extractProfileSmart, type RouterDeps } from "../src/routing/profile.js"

const GOOD_JSON = '{"required":["reasoning"],"preferred":["json"],"longform":false,"confidence":0.9}'

/** Mock-Provider: liefert das vorgegebene Ergebnis oder wirft den Fehler. */
function mockProvider(responseText?: string, error?: Error): LLMProvider {
	return {
		id: "mock-router",
		type: "ollama",
		label: "Mock Router",
		healthCheck: async () => ({ ok: true, latencyMs: 1 }),
		listModels: async () => [],
		cancel: async () => {},
		chat: (req: ChatRequest): AsyncGenerator<ChatChunk> => {
			const gen = (async function* () {
				if (error) {
					throw error
				}
				if (responseText !== undefined) {
					yield { type: "delta", text: responseText }
				}
				yield { type: "done" }
			})()
			void req
			return gen
		},
	}
}

function task(prompt: string) {
	return {
		id: "t-router",
		title: "Test",
		prompt,
		metadata: { privacy: "local-only", mode: "auto" },
		status: "draft",
		createdAt: new Date().toISOString(),
	}
}

describe("llmRouter: parseRouterResponse", () => {
	it("parst sauberes JSON", () => {
		const r = parseRouterResponse(GOOD_JSON)
		expect(r?.required).toEqual(["reasoning"])
		expect(r?.preferred).toEqual(["json"])
		expect(r?.confidence).toBeCloseTo(0.9)
		expect(r?.longform).toBe(false)
	})

	it("ignoriert Text-Randspalten (Markdown-Zaun, Worte davor)", () => {
		const r = parseRouterResponse(`Klar, hier die Antwort:\n\`\`\`json\n${GOOD_JSON}\n\`\`\``)
		expect(r?.required).toEqual(["reasoning"])
	})

	it("filtert unbekannte Fähigkeiten und entdoppelt", () => {
		const r = parseRouterResponse(
			'{"required":["code","code","quantum"],"preferred":[],"longform":true,"confidence":3}',
		)
		expect(r?.required).toEqual(["code"])
		expect(r?.longform).toBe(true)
		expect(r?.confidence).toBe(1) // auf [0,1] geklemmt
	})

	it("liefert undefined bei kaputtem JSON und bei Nicht-Objekten", () => {
		expect(parseRouterResponse("keine JSON")).toBeUndefined()
		expect(parseRouterResponse("{kaputt")).toBeUndefined()
		expect(parseRouterResponse("[1,2,3]")).toBeUndefined()
	})
})

describe("llmRouter: analyzePromptWithModel", () => {
	it("lädt den Prompt in den Call und liefert das geparste Ergebnis", async () => {
		let gesehen: ChatRequest | undefined
		const provider: LLMProvider = {
			...mockProvider(GOOD_JSON),
			chat: (req: ChatRequest): AsyncGenerator<ChatChunk> => {
				gesehen = req
				return mockProvider(GOOD_JSON).chat(req)
			},
		}
		const r = await analyzePromptWithModel(
			provider,
			{ enabled: true, timeoutMs: 5000, minConfidence: 0.5 },
			"Diagnosiere das Problem",
		)
		expect(r.required).toEqual(["reasoning"])
		expect(gesehen?.messages[0].content).toContain("Diagnosiere das Problem")
		expect(gesehen?.settings?.maxTokens).toBe(160)
	})

	it("wirft bei schlechtem JSON", async () => {
		await expect(
			analyzePromptWithModel(
				mockProvider("kein JSON hier"),
				{ enabled: true, timeoutMs: 5000, minConfidence: 0.5 },
				"p",
			),
		).rejects.toThrow(/JSON/)
	})

	it("wirft RouterTimeoutError, wenn der Provider die Frist verstreichen lässt", async () => {
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
					// Wartet auf den Timeout — oder wirft sofort, wenn der
					// Core das Signal abbricht, wie ein echter Adapter.
					await new Promise((resolve, reject) => {
						const t = setTimeout(() => resolve(null), 300)
						req.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t)
								reject(abortError())
							},
							{ once: true },
						)
					})
					yield { type: "delta", text: GOOD_JSON }
				})()
			},
		}
		await expect(
			analyzePromptWithModel(langsam, { enabled: true, timeoutMs: 50, minConfidence: 0.5 }, "p"),
		).rejects.toBeInstanceOf(RouterTimeoutError)
	})
})

describe("profile: extractProfileSmart (Kaskade)", () => {
	let db: Db
	let registry: ProviderRegistry
	let deps: RouterDeps

	const log = () => {}

	beforeEach(() => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-router-"))
		db = openDatabase(dataDir)
		migrate(db)
		registry = new ProviderRegistry(
			db,
			() => {},
			log,
			() => undefined,
		)
		registry.registerAdapter("mock-router", "ollama", "Mock Router", mockProvider(GOOD_JSON))
		deps = { db, registry, log }
	})

	it("läuft den Router nicht, wenn die Heuristik sicher ist (Code-Prompt)", async () => {
		const code = "Fix this bug:\n```python\ndef f(): pass\n```"
		const r = await extractProfileSmart(task(code), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toBe("heuristik sicher")
		expect(r.profile.requiredCapabilities).toContain("code")
	})

	it("bleibt bei der Heuristik, wenn der Router deaktiviert ist", async () => {
		setSetting(db, "routerModel", { enabled: false, timeoutMs: 30_000, minConfidence: 0.5 })
		const r = await extractProfileSmart(task("Hallo"), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toBe("router deaktiviert")
	})

	it("bleibt bei der Heuristik ohne vollständige Konfiguration", async () => {
		setSetting(db, "routerModel", { enabled: true, timeoutMs: 30_000, minConfidence: 0.5 })
		const r = await extractProfileSmart(task("Hallo"), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toBe("router unvollständig konfiguriert")
	})

	it("verwirft ein zögerndes Ergebnis (Konfidenz unter der Grenze)", async () => {
		registry.registerAdapter(
			"mock-zogernd",
			"ollama",
			"Zögernd",
			mockProvider('{"required":[],"preferred":[],"longform":false,"confidence":0.2}'),
		)
		setSetting(db, "routerModel", {
			enabled: true,
			providerId: "mock-zogernd",
			modelId: "klein",
			timeoutMs: 30_000,
			minConfidence: 0.5,
		})
		const r = await extractProfileSmart(task("Hallo"), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toBe("konfidenz zu niedrig")
	})

	it("klassifiziert mit dem Router, wenn Heuristik unsicher ist", async () => {
		setSetting(db, "routerModel", {
			enabled: true,
			providerId: "mock-router",
			modelId: "klein",
			timeoutMs: 30_000,
			minConfidence: 0.5,
		})
		const r = await extractProfileSmart(task("Hallo, was hältst du davon?"), 0, deps)
		expect(r.routerUsed).toBe(true)
		expect(r.profile.requiredCapabilities).toEqual(["reasoning"])
		expect(r.profile.preferredCapabilities).toContain("json")
	})

	it("fällt bei Provider-Fehler still auf die Heuristik zurück", async () => {
		registry.registerAdapter("mock-tot", "ollama", "Tot", mockProvider(undefined, new Error("offline")))
		setSetting(db, "routerModel", {
			enabled: true,
			providerId: "mock-tot",
			modelId: "klein",
			timeoutMs: 30_000,
			minConfidence: 0.5,
		})
		const base = extractProfile(task("Hallo"), 0)
		const r = await extractProfileSmart(task("Hallo"), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toContain("fehler:")
		expect(r.profile.requiredCapabilities).toEqual(base.requiredCapabilities)
	})

	it("meldet einen fehlenden Provider als Fallback", async () => {
		setSetting(db, "routerModel", {
			enabled: true,
			providerId: "gibt-es-nicht",
			modelId: "klein",
			timeoutMs: 30_000,
			minConfidence: 0.5,
		})
		const r = await extractProfileSmart(task("Hallo"), 0, deps)
		expect(r.routerUsed).toBe(false)
		expect(r.routerReason).toContain("gibt-es-nicht")
	})
})
