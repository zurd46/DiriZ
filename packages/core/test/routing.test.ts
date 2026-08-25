import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TaskProfile } from "@diriz/shared"
import { type Capability, DEFAULT_WEIGHTS, type InstanceModel } from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createProvider, sameServerProviders, upsertInstance } from "../src/db/repositories.js"
import { looksLikeLoadFailure } from "../src/execution/engine.js"
import { loadFactorFrom } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"
import type { PolicyCandidate } from "../src/routing/policies.js"
import { applyPolicies } from "../src/routing/policies.js"
import { scoreCandidate } from "../src/routing/scorer.js"

function instance(over: Partial<InstanceModel>): InstanceModel {
	return {
		id: "i-1",
		providerId: "p-1",
		modelId: "m-1",
		displayName: "M 1",
		contextWindow: 32_000,
		capabilities: ["code"],
		languages: ["python"],
		source: "discovered",
		status: "online",
		enabled: true,
		lastSeenAt: new Date().toISOString(),
		...over,
	}
}

function candidate(inst: InstanceModel, over: Partial<PolicyCandidate> = {}): PolicyCandidate {
	return {
		instance: inst,
		loadFactor: 0,
		basisPrior: 0.6,
		providerType: "ollama",
		providerOnline: true,
		...over,
	}
}

const profile = {
	estTokens: 10_000,
	requiredCapabilities: ["code"] as Capability[],
	preferredCapabilities: [] as Capability[],
	privacy: "local-only" as const,
	mode: "auto" as const,
}

describe("routing: Policies", () => {
	it("filtert Cloud-Provider bei local-only hart aus", () => {
		const local = candidate(instance({ id: "local", modelId: "llama" }))
		const cloud = candidate(instance({ id: "cloud", modelId: "gpt-4o" }), { providerType: "openrouter" })
		const { allowed, excluded } = applyPolicies([local, cloud], profile, DEFAULT_WEIGHTS)
		expect(allowed.map((c) => c.instance.id)).toEqual(["local"])
		expect(excluded).toHaveLength(1)
		expect(excluded[0]?.reason).toContain("local-only")
	})

	it("schließt deaktivierte Modelle pro Rechner aus (Modell-Auswahl)", () => {
		const on = candidate(instance({ id: "on" }))
		const off = candidate(instance({ id: "off", enabled: false }))
		const { allowed, excluded } = applyPolicies([on, off], profile, DEFAULT_WEIGHTS)
		expect(allowed.map((c) => c.instance.id)).toEqual(["on"])
		expect(excluded).toHaveLength(1)
		expect(excluded[0]?.reason).toContain("deaktiviert")
	})

	it("erlaubt Cloud bei allow-cloud", () => {
		const cloud = candidate(instance({ id: "cloud" }), { providerType: "openai" })
		const { allowed, excluded } = applyPolicies(
			[cloud],
			{ ...profile, privacy: "allow-cloud", requiredCapabilities: [] },
			DEFAULT_WEIGHTS,
		)
		expect(allowed).toHaveLength(1)
		expect(excluded).toHaveLength(0)
	})

	it("schließt teure Cloud-Modelle aus, wenn das Budget nicht reicht (Budget-Gate)", () => {
		const cheap = candidate(instance({ id: "cheap", pricePerMTok: { in: 0.1, out: 0.3 } }), {
			providerType: "openrouter",
		})
		const expensive = candidate(instance({ id: "expensive", pricePerMTok: { in: 5, out: 15 } }), {
			providerType: "openrouter",
		})
		const prof = { ...profile, privacy: "allow-cloud" as const, budgetUsd: 0.05 }
		// estTokens=10_000 → cheap Ø 0.2 $/MTok ≈ 0.002 $ (OK); expensive Ø 10 $/MTok = 0.1 $ (> 0.05)
		const { allowed, excluded } = applyPolicies([cheap, expensive], prof, DEFAULT_WEIGHTS)
		expect(allowed.map((c) => c.instance.id)).toEqual(["cheap"])
		expect(excluded).toHaveLength(1)
		expect(excluded[0]?.reason).toContain("Budget")
	})

	it("lässt lokale (kostenlose) Modelle auch mit kleinem Budget zu", () => {
		const local = candidate(instance({ id: "local" }))
		const prof = { ...profile, budgetUsd: 0.01 }
		const { allowed, excluded } = applyPolicies([local], prof, DEFAULT_WEIGHTS)
		expect(allowed).toHaveLength(1)
		expect(excluded).toHaveLength(0)
	})

	it("schließt zu kleine Context-Fenster aus (Gate 1.2×)", () => {
		const small = candidate(instance({ id: "small", contextWindow: 4096 }))
		const { allowed, excluded } = applyPolicies([small], profile, DEFAULT_WEIGHTS)
		expect(allowed).toHaveLength(0)
		expect(excluded[0]?.reason).toContain("Context")
	})

	it("schließt fehlende Pflicht-Capabilities aus", () => {
		const noCode = candidate(instance({ id: "nocode", capabilities: ["longform"] }))
		const { allowed, excluded } = applyPolicies([noCode], profile, DEFAULT_WEIGHTS)
		expect(allowed).toHaveLength(0)
		expect(excluded[0]?.reason).toContain("code")
	})

	it("pinnt bei mode=pinned auf Provider & Modell", () => {
		const right = candidate(instance({ id: "ok", providerId: "p-2", modelId: "wanted" }))
		const wrongModel = candidate(instance({ id: "wm", providerId: "p-2", modelId: "other" }))
		const { allowed, excluded } = applyPolicies(
			[right, wrongModel],
			{
				...profile,
				mode: "pinned",
				pinnedProviderId: "p-2",
				pinnedModelId: "wanted",
				requiredCapabilities: [],
			},
			DEFAULT_WEIGHTS,
		)
		expect(allowed.map((c) => c.instance.id)).toEqual(["ok"])
		expect(excluded).toHaveLength(1)
	})

	it("schließt offline-Provider aus", () => {
		const off = candidate(instance({ id: "off" }), { providerOnline: false })
		const { allowed, excluded } = applyPolicies([off], profile, DEFAULT_WEIGHTS)
		expect(allowed).toHaveLength(0)
		expect(excluded[0]?.reason).toContain("offline")
	})
})

describe("routing: Scorer", () => {
	it("ist deterministisch und liefert 0–100 mit Achsen", () => {
		const feedback = new Feedback()
		const cand = candidate(instance({}))
		const a = scoreCandidate(cand, profile, DEFAULT_WEIGHTS, feedback)
		const b = scoreCandidate(cand, profile, DEFAULT_WEIGHTS, feedback)
		expect(a.score).toBe(b.score)
		expect(a.score).toBeGreaterThanOrEqual(0)
		expect(a.score).toBeLessThanOrEqual(100)
		// M8: + hostLoad, M9: + Eignung (`llm.md`), + freier Rechner, + Tempo
		expect(a.axes).toHaveLength(10)
		for (const axis of a.axes) {
			expect(axis.weighted).toBeCloseTo(axis.value * axis.weight, 3)
		}
	})

	it("belohnt besseres Modell (größeres Context-Fenster)", () => {
		const feedback = new Feedback()
		const big = candidate(instance({ id: "big", contextWindow: 32_000 }))
		const small = candidate(instance({ id: "small", contextWindow: 12_000 }))
		const profileBig = { ...profile, estTokens: 10_000, requiredCapabilities: [] }
		expect(scoreCandidate(big, profileBig, DEFAULT_WEIGHTS, feedback).score).toBeGreaterThan(
			scoreCandidate(small, profileBig, DEFAULT_WEIGHTS, feedback).score,
		)
	})

	it("lädt Qualitätsprior aus Feedback (Ratings + Erfolgsquote)", () => {
		const good = new Feedback()
		good.record("i-good", true, 5)
		good.record("i-good", true, 4)
		const bad = new Feedback()
		bad.record("i-bad", false)
		bad.record("i-bad", false)
		const base = { ...profile, requiredCapabilities: [] }
		const scoreGood = scoreCandidate(
			candidate(instance({ id: "i-good" }), { basisPrior: 0.6 }),
			base,
			DEFAULT_WEIGHTS,
			good,
		).score
		const scoreBad = scoreCandidate(
			candidate(instance({ id: "i-bad" }), { basisPrior: 0.6 }),
			base,
			DEFAULT_WEIGHTS,
			bad,
		).score
		expect(scoreGood).toBeGreaterThan(scoreBad)
	})

	it("bestraft hohe Last (Load-Faktor)", () => {
		const feedback = new Feedback()
		const idle = candidate(instance({ id: "idle" }), { loadFactor: 0 })
		const busy = candidate(instance({ id: "busy" }), { loadFactor: 0.9 })
		const base = { ...profile, requiredCapabilities: [] }
		expect(scoreCandidate(idle, base, DEFAULT_WEIGHTS, feedback).score).toBeGreaterThan(
			scoreCandidate(busy, base, DEFAULT_WEIGHTS, feedback).score,
		)
	})
})

/**
 * GPU-Schutz: Ein Rechner darf nie zwei **verschiedene** Modelle gleichzeitig
 * ausführen — jedes zusätzliche Modell belegt eigenen Grafikspeicher. Statt den
 * Rechner zu überfahren, weicht das Routing auf einen anderen aus.
 */
describe("routing: GPU-Schutz & Verteilung auf mehrere Rechner", () => {
	const limits = { global: 4, perProvider: 2, maxModelsPerProvider: 1 }

	it("schliesst ein zweites Modell auf einem belegten Rechner aus", () => {
		const anderes = candidate(instance({ id: "i-2", modelId: "m-2" }), {
			providerActiveCount: 1,
			providerActiveModels: ["m-1"],
		})
		const { allowed, excluded } = applyPolicies([anderes], profile, DEFAULT_WEIGHTS, limits)
		expect(allowed).toHaveLength(0)
		expect(excluded[0]?.reason).toContain("GPU-Schutz")
		expect(excluded[0]?.reason).toContain("m-1")
	})

	it("lässt dasselbe Modell weiterlaufen — es ist bereits geladen", () => {
		const gleiches = candidate(instance({ id: "i-1", modelId: "m-1" }), {
			providerActiveCount: 1,
			providerActiveModels: ["m-1"],
		})
		const { allowed } = applyPolicies([gleiches], profile, DEFAULT_WEIGHTS, limits)
		expect(allowed.map((c) => c.instance.id)).toEqual(["i-1"])
	})

	it("verteilt auf einen zweiten Rechner, statt den ersten zu überfahren", () => {
		const belegt = candidate(instance({ id: "i-1", providerId: "p-1", modelId: "m-1" }), {
			providerActiveCount: 1,
			providerActiveModels: ["m-9"],
		})
		const frei = candidate(instance({ id: "i-2", providerId: "p-2", modelId: "m-2" }), {
			providerActiveCount: 0,
			providerActiveModels: [],
		})
		const { allowed } = applyPolicies([belegt, frei], profile, DEFAULT_WEIGHTS, limits)
		expect(allowed.map((c) => c.instance.id)).toEqual(["i-2"])
	})

	it("hält die Grenze gleichzeitiger Ausführungen pro Rechner ein", () => {
		const voll = candidate(instance({ id: "i-1", modelId: "m-1" }), {
			providerActiveCount: 2,
			providerActiveModels: ["m-1"],
		})
		const { allowed, excluded } = applyPolicies([voll], profile, DEFAULT_WEIGHTS, limits)
		expect(allowed).toHaveLength(0)
		expect(excluded[0]?.reason).toContain("Rechner ausgelastet")
	})

	it("erlaubt mehrere Modelle, wenn die Grenze höher steht (viel VRAM)", () => {
		const zweites = candidate(instance({ id: "i-2", modelId: "m-2" }), {
			providerActiveCount: 1,
			providerActiveModels: ["m-1"],
		})
		const { allowed } = applyPolicies([zweites], profile, DEFAULT_WEIGHTS, {
			...limits,
			maxModelsPerProvider: 2,
		})
		expect(allowed.map((c) => c.instance.id)).toEqual(["i-2"])
	})

	it("ohne Grenzen bleibt alles beim Alten (Rückwärtskompatibilität)", () => {
		const belegt = candidate(instance({ id: "i-1", modelId: "m-2" }), {
			providerActiveCount: 9,
			providerActiveModels: ["m-1"],
		})
		expect(applyPolicies([belegt], profile, DEFAULT_WEIGHTS).allowed).toHaveLength(1)
	})
})

/**
 * Die Richtung der Last-Achse ist entscheidend: Ein bereits geladenes Modell
 * ist der **günstigste** Kandidat (kein zusätzlicher Grafikspeicher, kein
 * Ladevorgang) — nicht der teuerste.
 */
describe("routing: Lastfaktor eines Rechners", () => {
	it("wertet ein bereits geladenes Modell als frei", () => {
		const load = { loadedModels: [{ modelId: "m-1", memoryBytes: 8e9 }], totalMemoryBytes: 16e9 }
		expect(loadFactorFrom(load, "m-1")).toBe(0)
	})

	it("bestraft fremde Modelle anteilig am Grafikspeicher", () => {
		const load = { loadedModels: [{ modelId: "m-9", memoryBytes: 12e9 }], totalMemoryBytes: 16e9 }
		expect(loadFactorFrom(load, "m-1")).toBeCloseTo(0.75)
	})

	it("schätzt halbe Belegung, wenn die Speichergrössen fehlen (LM Studio)", () => {
		const load = { loadedModels: [{ modelId: "m-9", memoryBytes: 0 }] }
		expect(loadFactorFrom(load, "m-1")).toBe(0.5)
	})

	it("bleibt neutral, wenn der Rechner keine Auskunft gibt", () => {
		expect(loadFactorFrom(undefined, "m-1")).toBe(0)
		expect(loadFactorFrom({ loadedModels: [] }, "m-1")).toBe(0)
	})
})

/**
 * Die Lockerung des Fähigkeits-Gates darf keine Einbettungs-Modelle
 * hereinlassen: Sie sind kein schwächeres Werkzeug, sondern gar keines — statt
 * einer Antwort käme ein Vektor zurück.
 */
describe("routing: Gate-Lockerung", () => {
	it("lässt ein Modell ohne jede Fähigkeit auch dann draussen, wenn nichts übrig bleibt", () => {
		const embedder = candidate(instance({ id: "embed", modelId: "nomic-embed-text", capabilities: [] }))
		const chat = candidate(instance({ id: "chat", capabilities: ["reasoning"] }))
		// So filtert die Engine, bevor sie ohne Pflicht-Fähigkeiten neu bewertet.
		const übrig = [embedder, chat].filter((c) => c.instance.capabilities.length > 0)
		const { allowed } = applyPolicies(übrig, { ...profile, requiredCapabilities: [] }, DEFAULT_WEIGHTS)
		expect(allowed.map((c) => c.instance.id)).toEqual(["chat"])
	})
})

/**
 * Ein Modell, das der Server nicht laden kann, ist nicht „gerade unpässlich" —
 * es ist unbrauchbar, bis sich etwas ändert. Ohne diese Unterscheidung wählt
 * das Routing es beim nächsten Auftrag wieder (bester Score) und verliert
 * erneut eine Minute im Ladeversuch.
 */
describe("routing: Ladefehler erkennen", () => {
	it("erkennt die typischen Meldungen eines gescheiterten Ladevorgangs", () => {
		const treffer = [
			'HTTP 400 — { "error": { "message": "Failed to load model \\"qwen/qwen3.8-27b\\". Error: Engine protocol startup was aborted." } }',
			"Model not found: llama3:70b",
			"CUDA out of memory",
			"insufficient memory to load model",
		]
		for (const t of treffer) {
			expect(looksLikeLoadFailure(t), t).toBe(true)
		}
	})

	it("hält gewöhnliche Laufzeitfehler auseinander — die sperren kein Modell", () => {
		const daneben = [
			"Kein Chunk seit 180 s",
			"Gesamt-Timeout nach 900 s",
			"HTTP 500 Internal Server Error — HTML-Antwort: Error",
			"Abgebrochen vom Nutzer",
		]
		for (const t of daneben) {
			expect(looksLikeLoadFailure(t), t).toBe(false)
		}
	})
})

/**
 * Zwei Provider-Einträge können **dieselbe Maschine** sein — direkt und über
 * einen Tunnel. Nachgewiesen an einer echten Anlage: Ein über den lokalen
 * Endpunkt geladenes Modell erschien im selben Augenblick am Tunnel-Endpunkt
 * als geladen. Ohne Erkennung hält die Grafikkarte zwei Modelle, wo eines
 * hingehört — und das erste fliegt mitten im Stream heraus.
 */
describe("routing: derselbe Server hinter zwei Einträgen", () => {
	it("erkennt gleiche Modell-Listen als eine Maschine", () => {
		const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-dupe-")))
		migrate(db)
		const lokal = createProvider(db, { type: "lmstudio", label: "Lokal", baseUrl: "http://127.0.0.1:1234" })
		const tunnel = createProvider(db, {
			type: "lmstudio",
			label: "Tunnel",
			baseUrl: "https://x.ngrok.dev/v1",
		})
		const andere = createProvider(db, {
			type: "ollama",
			label: "Anderer",
			baseUrl: "http://192.168.1.9:11434",
		})

		for (const p of [lokal, tunnel]) {
			for (const m of ["modell-a", "modell-b"]) {
				upsertInstance(db, p.id, { modelId: m, displayName: m, contextWindow: 8192 }, "manual")
			}
		}
		upsertInstance(db, andere.id, { modelId: "ganz-anders", displayName: "X", contextWindow: 8192 }, "manual")

		const gruppe = sameServerProviders(db, lokal.id).sort()
		expect(gruppe).toEqual([lokal.id, tunnel.id].sort())
		// Der dritte Rechner bleibt für sich.
		expect(sameServerProviders(db, andere.id)).toEqual([andere.id])
		db.close()
	})

	it("fasst nichts zusammen, solange die Listen sich unterscheiden", () => {
		const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-dupe2-")))
		migrate(db)
		const a = createProvider(db, { type: "lmstudio", label: "A", baseUrl: "http://a:1234" })
		const b = createProvider(db, { type: "lmstudio", label: "B", baseUrl: "http://b:1234" })
		upsertInstance(db, a.id, { modelId: "m1", displayName: "m1", contextWindow: 8192 }, "manual")
		upsertInstance(db, b.id, { modelId: "m1", displayName: "m1", contextWindow: 8192 }, "manual")
		upsertInstance(db, b.id, { modelId: "m2", displayName: "m2", contextWindow: 8192 }, "manual")

		expect(sameServerProviders(db, a.id)).toEqual([a.id])
		expect(sameServerProviders(db, b.id)).toEqual([b.id])
		db.close()
	})
})

describe("Pin: der Rechner zählt, nicht die Tür", () => {
	function kandidat(providerId: string, modelId: string, online: boolean): PolicyCandidate {
		return {
			instance: {
				id: `${providerId}-${modelId}`,
				providerId,
				modelId,
				displayName: modelId,
				contextWindow: 32_000,
				capabilities: ["code"],
				languages: [],
				source: "manual",
				status: "online",
				enabled: true,
			},
			loadFactor: 0,
			providerLatencyMs: 10,
			basisPrior: 0.5,
			local: true,
			providerType: "lmstudio",
			providerOnline: online,
		} as unknown as PolicyCandidate
	}

	it("nimmt den zweiten Zugang, wenn der gepinnte Weg tot ist", () => {
		// Der echte Fall: Spezialist auf `MacDani` gepinnt, dort war LM Studio
		// aus — und DiriZ meldete „Keine Instanz verfügbar (29 ausgeschlossen)",
		// obwohl `lokalai` online ist und auf dieselbe Grafikkarte zeigt.
		const kandidaten = [kandidat("macdani", "qwen3-coder", false), kandidat("lokalai", "qwen3-coder", true)]
		const profil = {
			mode: "pinned",
			pinnedProviderId: "macdani",
			requiredCapabilities: [],
			preferredCapabilities: [],
		} as unknown as TaskProfile

		const ohneWissen = applyPolicies(kandidaten, profil, DEFAULT_WEIGHTS)
		expect(ohneWissen.allowed).toHaveLength(0)

		const mitWissen = applyPolicies(kandidaten, profil, DEFAULT_WEIGHTS, undefined, undefined, (id) =>
			id === "macdani" || id === "lokalai" ? ["macdani", "lokalai"] : [id],
		)
		expect(mitWissen.allowed.map((c) => c.instance.providerId)).toEqual(["lokalai"])
	})

	it("öffnet den Pin nicht für fremde Rechner", () => {
		const kandidaten = [kandidat("macdani", "qwen3-coder", false), kandidat("cloud", "qwen3-coder", true)]
		const profil = {
			mode: "pinned",
			pinnedProviderId: "macdani",
			requiredCapabilities: [],
			preferredCapabilities: [],
		} as unknown as TaskProfile
		const r = applyPolicies(kandidaten, profil, DEFAULT_WEIGHTS, undefined, undefined, () => ["macdani"])
		expect(r.allowed).toHaveLength(0)
		expect(r.excluded.some((e) => e.reason.includes("Pinned auf Rechner"))).toBe(true)
	})
})

describe("Verschwundene Modelle", () => {
	function kand(modelId: string, stale: boolean): PolicyCandidate {
		return {
			instance: {
				id: modelId,
				providerId: "macdani",
				modelId,
				displayName: modelId,
				contextWindow: 32_000,
				capabilities: ["code"],
				languages: [],
				source: "discovered",
				status: "online",
				enabled: true,
				lastSeenAt: "2026-08-25T13:48:57.000Z",
			},
			loadFactor: 0,
			providerLatencyMs: 10,
			basisPrior: 0.5,
			local: true,
			providerType: "lmstudio",
			providerOnline: true,
			instanceStale: stale,
		} as unknown as PolicyCandidate
	}

	it("wählt nicht unter Modellen, die der Rechner nicht mehr anbietet", () => {
		// Der echte Fall: „LM Link" am Mac abgeschaltet — elf durchgereichte
		// Modelle verschwanden, blieben aber in der Datenbank stehen. Ohne Gate
		// sucht das Routing das beste davon aus und bekommt „model not found".
		const r = applyPolicies(
			[kand("nvidia-nemotron", true), kand("qwen3.8-27b", false)],
			{ mode: "balanced", requiredCapabilities: [], preferredCapabilities: [] } as unknown as TaskProfile,
			DEFAULT_WEIGHTS,
		)
		expect(r.allowed.map((c) => c.instance.modelId)).toEqual(["qwen3.8-27b"])
		expect(r.excluded[0].reason).toContain("nicht mehr angeboten")
	})
})
