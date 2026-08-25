/**
 * Warmhalten: Ein Ping hält geladene Modelle im Speicher — aber nur, solange
 * das Sinn ergibt.
 *
 * Der Anlass für die Tests: 55 identische Fehlschläge für ein Modell, das der
 * Rechner nicht laden kann („insufficient system resources"), alle vier
 * Minuten einer, jeder mit einem Ladeversuch auf der Grafikkarte.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatChunk, ChatRequest, DiscoveredModel, HealthStatus, LLMProvider } from "@diriz/shared"
import { beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createProvider, listInstances, lockInstance, upsertInstance } from "../src/db/repositories.js"
import { DEFAULT_WARMUP, WarmKeeper } from "../src/execution/warmup.js"
import { isLocalEndpoint, parseLinkStatus } from "../src/providers/lmlink.js"

/** Adapter, der wahlweise antwortet oder das Laden verweigert. */
class WarmFake implements LLMProvider {
	readonly label = "WarmFake"
	readonly supportsTools = false
	calls: string[] = []
	constructor(
		readonly id: string,
		readonly type = "lmstudio" as const,
		private failWith?: string,
	) {}
	async healthCheck(): Promise<HealthStatus> {
		return { ok: true, latencyMs: 1 }
	}
	async listModels(): Promise<DiscoveredModel[]> {
		return []
	}
	async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
		this.calls.push(req.model ?? "")
		if (this.failWith) {
			throw new Error(this.failWith)
		}
		yield { type: "done" }
	}
	async cancel(): Promise<void> {}
}

let db: Db
let providerId: string

beforeEach(() => {
	db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-warm-")))
	migrate(db)
	providerId = createProvider(db, { type: "lmstudio", label: "Rechner", baseUrl: "http://x" }).id
	upsertInstance(
		db,
		providerId,
		{ modelId: "zu-gross", displayName: "Zu gross", contextWindow: 8192, capabilities: ["reasoning"] },
		"manual",
	)
})

function keeper(adapter: WarmFake, geladen: string[] = []) {
	const registry = {
		providerIds: [providerId],
		status: () => "online" as const,
		adapter: () => adapter,
		labelOf: () => "Rechner",
		loadedModelsOf: () => geladen,
	}
	return new WarmKeeper({
		db,
		// Nur die Teile der Registry, die das Warmhalten anfasst.
		registry: registry as unknown as ConstructorParameters<typeof WarmKeeper>[0]["registry"],
		log: () => {},
		isBusy: () => false,
		settings: () => DEFAULT_WARMUP,
	})
}

describe("WarmKeeper", () => {
	it("hält das geladene Modell warm, statt ein anderes zu laden", async () => {
		const adapter = new WarmFake("p")
		await keeper(adapter, ["schon-geladen"]).runOnce()
		expect(adapter.calls).toEqual(["schon-geladen"])
	})

	it("gibt ein Modell auf, das sich zweimal nicht laden liess", async () => {
		const adapter = new WarmFake("p", "lmstudio", "Model loading was stopped due to insufficient resources")
		const k = keeper(adapter)
		await k.runOnce()
		await k.runOnce()
		await k.runOnce()
		await k.runOnce()
		// Zwei Versuche, danach Ruhe — nicht 55.
		expect(adapter.calls).toHaveLength(2)
	})

	it("rührt einen arbeitenden Rechner nicht an", async () => {
		const adapter = new WarmFake("p")
		const k = new WarmKeeper({
			db,
			registry: {
				providerIds: [providerId],
				status: () => "online" as const,
				adapter: () => adapter,
				labelOf: () => "Rechner",
				loadedModelsOf: () => ["egal"],
			} as unknown as ConstructorParameters<typeof WarmKeeper>[0]["registry"],
			log: () => {},
			isBusy: () => true,
			settings: () => DEFAULT_WARMUP,
		})
		await k.runOnce()
		expect(adapter.calls).toHaveLength(0)
	})

	it("tut nichts, wenn es abgeschaltet ist", async () => {
		const adapter = new WarmFake("p")
		const k = new WarmKeeper({
			db,
			registry: {
				providerIds: [providerId],
				status: () => "online" as const,
				adapter: () => adapter,
				labelOf: () => "Rechner",
				loadedModelsOf: () => ["egal"],
			} as unknown as ConstructorParameters<typeof WarmKeeper>[0]["registry"],
			log: () => {},
			isBusy: () => false,
			settings: () => ({ ...DEFAULT_WARMUP, enabled: false }),
		})
		await k.runOnce()
		expect(adapter.calls).toHaveLength(0)
	})
})

describe("WarmKeeper: eine Maschine, ein Warmhalten", () => {
	it("wärmt einen Rechner nur einmal, auch wenn zwei Einträge auf ihn zeigen", async () => {
		// `lokalai` (Tunnel) und `MacDani` (127.0.0.1) sind derselbe Rechner —
		// erkannt an der identischen Modell-Liste. Zwei Ladeversuche im selben
		// Moment brachten LM Studio nachweislich zum Straucheln.
		const zweiter = createProvider(db, { type: "lmstudio", label: "Tunnel", baseUrl: "https://x.ngrok" }).id
		upsertInstance(
			db,
			zweiter,
			{ modelId: "zu-gross", displayName: "Zu gross", contextWindow: 8192, capabilities: ["reasoning"] },
			"manual",
		)
		const adapter = new WarmFake("p")
		const registry = {
			providerIds: [providerId, zweiter],
			status: () => "online" as const,
			adapter: () => adapter,
			labelOf: () => "Rechner",
			loadedModelsOf: () => [],
		}
		const k = new WarmKeeper({
			db,
			registry: registry as unknown as ConstructorParameters<typeof WarmKeeper>[0]["registry"],
			log: () => {},
			isBusy: () => false,
			settings: () => DEFAULT_WARMUP,
		})
		await k.runOnce()
		expect(adapter.calls).toEqual(["zu-gross"])
	})

	it("lässt ein gesperrtes Modell in Ruhe", async () => {
		const inst = listInstances(db, providerId)[0]
		lockInstance(db, inst.id, new Date(Date.now() + 600_000).toISOString())
		const adapter = new WarmFake("p")
		await keeper(adapter).runOnce()
		expect(adapter.calls).toEqual([])
	})
})

describe("LM Link: wo rechnet das Modell?", () => {
	it("liest Gerätenamen und Kennungen aus `lms link status`", () => {
		// Wortgetreu die Ausgabe von LM Studio 0.4 auf dem Rechner des Nutzers.
		const ausgabe = [
			"This device: MacBook-Pro-von-Daniel.local",
			"Status: Online",
			"",
			"Found 1 device:",
			"",
			"  - LokalAI_Server1",
			"    Status: connected",
			"    Identifier: dc6370d36a292bacd8e25a52652e3b70",
			"    Loaded Models Instances:",
			"      - nvidia-nemotron-3.5-lightning-30b-a3b",
		].join("\n")
		const { eigener, namen } = parseLinkStatus(ausgabe)
		expect(eigener).toBe("MacBook-Pro-von-Daniel.local")
		expect(namen.get("dc6370d36a292bacd8e25a52652e3b70")).toBe("LokalAI_Server1")
		// Das geladene Modell steht in derselben Einrückung wie ein Gerät — es
		// darf trotzdem nicht als eines gezählt werden.
		expect(namen.size).toBe(1)
	})

	it("hält einen Tunnel nicht für den eigenen Rechner", () => {
		// Über einen Tunnel befragte `lms` den falschen Rechner: den eigenen.
		expect(isLocalEndpoint("http://127.0.0.1:1234")).toBe(true)
		expect(isLocalEndpoint("http://localhost:1234")).toBe(true)
		expect(isLocalEndpoint("https://lokalai.ngrok.dev/v1")).toBe(false)
	})
})
