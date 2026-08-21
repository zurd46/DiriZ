/**
 * Provider-Registry (`01-plan.md` §4–§5): hält Adapter, Gesundheitsstatus,
 * Circuit-Breaker, Latenz-History, Load-Info & Discovery-Polling.
 *
 * Der Circuit-Breaker öffnet nach 3 Fehlern, bleibt 60 s geschlossen und
 * lässt dann genau einen Test-Request durch (half-open).
 */

import {
	CIRCUIT_BREAKER,
	type CoreEvent,
	HEALTH_POLL_MS,
	type InstanceModel,
	type LLMProvider,
	type ProviderStatus,
	type ProviderType,
} from "@diriz/shared"
import type { Db } from "../db/connection.js"
import { listInstances, setInstanceStatus, setProviderStatus, upsertInstance } from "../db/repositories.js"
import type { LogEntry } from "../logger.js"
import { createProvider } from "./factory.js"

const CB_THRESHOLD = CIRCUIT_BREAKER.failureThreshold
const CB_COOLDOWN_MS = CIRCUIT_BREAKER.openMs
const LATENCY_WINDOW = 20
const POLL_INTERVAL_MS = HEALTH_POLL_MS

interface CircuitState {
	failures: number
	openUntil: number
}

interface LatencySample {
	ms: number
}

export interface ProviderEntry {
	providerId: string
	type: ProviderType
	label: string
	baseUrl: string
	adapter: LLMProvider
}

type EmitFn = (event: CoreEvent) => void
type LogFn = (level: LogEntry["level"], scope: string, msg: string) => void
type ApiKeyResolver = (providerId: string) => string | undefined

export class ProviderRegistry {
	private adapters = new Map<string, LLMProvider>()
	private meta = new Map<string, ProviderEntry>()
	private circuits = new Map<string, CircuitState>()
	private latencySamples = new Map<string, LatencySample[]>()
	private pollers = new Map<string, NodeJS.Timeout>()
	private statuses = new Map<string, ProviderStatus>()
	private loads = new Map<
		string,
		{ loadedModels: { modelId: string; memoryBytes: number }[]; totalMemoryBytes?: number }
	>()

	constructor(
		private db: Db,
		private emit: EmitFn,
		private log: LogFn,
		private resolveApiKey: ApiKeyResolver,
	) {}

	/* ------------------------------ Registrierung ----------------------------- */

	register(providerId: string, type: ProviderType, baseUrl: string, label: string): void {
		const adapter = createProvider(providerId, type, baseUrl, this.resolveApiKey(providerId), label)
		this.adapters.set(providerId, adapter)
		this.meta.set(providerId, { providerId, type, label, baseUrl, adapter })
		this.circuits.set(providerId, { failures: 0, openUntil: 0 })
		this.log("info", "registry", `Provider registriert: ${label} (${type})`)
	}

	unregister(providerId: string): void {
		this.stopPolling(providerId)
		this.adapters.delete(providerId)
		this.meta.delete(providerId)
		this.circuits.delete(providerId)
		this.latencySamples.delete(providerId)
		this.statuses.delete(providerId)
		this.loads.delete(providerId)
	}

	/**
	 * Direkte Adapter-Registrierung (z. B. eigene OpenAI-kompatible Server
	 * oder Tests) — umgeht die Fabrik.
	 */
	registerAdapter(providerId: string, type: ProviderType, label: string, adapter: LLMProvider): void {
		this.adapters.set(providerId, adapter)
		this.meta.set(providerId, { providerId, type, label, baseUrl: "", adapter })
		this.circuits.set(providerId, { failures: 0, openUntil: 0 })
	}

	get providerIds(): string[] {
		return [...this.adapters.keys()]
	}

	adapter(providerId: string): LLMProvider | undefined {
		return this.adapters.get(providerId)
	}

	providerType(providerId: string): ProviderType | undefined {
		return this.meta.get(providerId)?.type
	}

	/* ------------------------------ Gesundheitscheck --------------------------- */

	/**
	 * Health-Check mit Circuit-Breaker. `false`, wenn der Breaker offen ist
	 * (kein Request raus), sonst der Ergebnisstatus.
	 */
	async checkHealth(providerId: string): Promise<boolean> {
		const entry = this.meta.get(providerId)
		if (!entry) {
			return false
		}
		if (this.isCircuitOpen(providerId)) {
			return false
		}
		const health = await entry.adapter.healthCheck()
		this.recordOutcome(providerId, health.ok, health.detail)
		this.setStatus(providerId, health.ok ? "online" : "offline")
		if (health.ok) {
			this.recordLatency(providerId, health.latencyMs)
		}
		this.emit({
			event: "provider.status",
			data: { providerId, status: health.ok ? "online" : "offline" },
		})
		this.log(
			health.ok ? "info" : "error",
			"health",
			`${entry.label}: ${health.ok ? "online" : `offline (${health.detail ?? "?"})`}`,
		)
		return health.ok
	}

	/** Failover-Ereignis des Engines (Fehler bei einer Chat-Anfrage). */
	recordFailure(providerId: string, detail?: string): void {
		this.recordOutcome(providerId, false, detail)
		this.setStatus(providerId, "degraded")
		this.emit({ event: "provider.status", data: { providerId, status: "degraded" } })
	}

	recordSuccess(providerId: string): void {
		this.recordOutcome(providerId, true)
		this.setStatus(providerId, "online")
	}

	private recordOutcome(providerId: string, ok: boolean, detail?: string): void {
		const circuit = this.circuits.get(providerId)
		if (!circuit) {
			return
		}
		if (ok) {
			circuit.failures = 0
			circuit.openUntil = 0
			return
		}
		circuit.failures += 1
		if (circuit.failures >= CB_THRESHOLD) {
			circuit.openUntil = Date.now() + CB_COOLDOWN_MS
			circuit.failures = 0
			this.log(
				"warn",
				"circuit",
				`${providerId}: Circuit-Breaker öffnet für ${CB_COOLDOWN_MS / 1000} s (${detail ?? `${CB_THRESHOLD} Fehler in Folge`})`,
			)
		}
	}

	/** Half-open: nach dem Cooldown genau ein Request erlaubt. */
	isCircuitOpen(providerId: string): boolean {
		const c = this.circuits.get(providerId)
		return !!c && c.openUntil > Date.now()
	}

	/* --------------------------------- Latenz --------------------------------- */

	recordLatency(providerId: string, ms: number): void {
		const samples = this.latencySamples.get(providerId) ?? []
		samples.push({ ms })
		if (samples.length > LATENCY_WINDOW) {
			samples.shift()
		}
		this.latencySamples.set(providerId, samples)
		this.persistLatency(providerId)
	}

	latency(providerId: string): { p50?: number; p95?: number } {
		const samples = (this.latencySamples.get(providerId) ?? []).map((s) => s.ms).sort((a, b) => a - b)
		if (samples.length === 0) {
			return {}
		}
		return {
			p50: samples[Math.floor(samples.length * 0.5)],
			p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))],
		}
	}

	private persistLatency(providerId: string): void {
		const { p50, p95 } = this.latency(providerId)
		setProviderStatus(this.db, providerId, this.statuses.get(providerId) ?? "online", p50, p95)
	}

	/* --------------------------------- Status --------------------------------- */

	status(providerId: string): ProviderStatus {
		return this.statuses.get(providerId) ?? "offline"
	}

	private setStatus(providerId: string, status: ProviderStatus): void {
		this.statuses.set(providerId, status)
		this.persistLatency(providerId)
	}

	/* ------------------------------- Discovery -------------------------------- */

	/** Modelle holen + in SQLite upserten. */
	async refreshDiscovery(providerId: string): Promise<void> {
		const entry = this.meta.get(providerId)
		if (!entry) {
			return
		}
		const models = await entry.adapter.listModels()
		for (const m of models) {
			upsertInstance(this.db, providerId, m, "discovered")
		}
		this.log("info", "discovery", `${entry.label}: ${models.length} Modelle entdeckt`)
	}

	/** Polling starten (Health + Discovery), idempotent. */
	startPolling(providerId: string, intervalMs = POLL_INTERVAL_MS): void {
		if (this.pollers.has(providerId)) {
			return
		}
		const tick = () => {
			void (async () => {
				try {
					await this.checkHealth(providerId)
					await this.refreshDiscovery(providerId)
				} catch (e) {
					this.log("error", "polling", `${providerId}: ${e instanceof Error ? e.message : String(e)}`)
				}
			})()
		}
		tick()
		this.pollers.set(providerId, setInterval(tick, intervalMs))
	}

	stopPolling(providerId: string): void {
		const timer = this.pollers.get(providerId)
		if (timer) {
			clearInterval(timer)
			this.pollers.delete(providerId)
		}
	}

	/** Alle aktiven Poller stoppen (Shutdown). */
	stopAllPolling(): void {
		for (const id of this.pollers.keys()) {
			this.stopPolling(id)
		}
	}

	/* ------------------------------- Load-Balancing ---------------------------- */

	/** Load-Info des Adapters laden (Ollama: `/api/ps`), sonst `undefined`. */
	async loadInfo(
		providerId: string,
	): Promise<
		{ loadedModels: { modelId: string; memoryBytes: number }[]; totalMemoryBytes?: number } | undefined
	> {
		const adapter = this.adapters.get(providerId) as
			| (LLMProvider & {
					loadInfo?: () => Promise<{
						loadedModels: { modelId: string; memoryBytes: number }[]
						totalMemoryBytes?: number
					}>
			  })
			| undefined
		if (!adapter || typeof adapter.loadInfo !== "function") {
			return undefined
		}
		const info = await adapter.loadInfo()
		this.loads.set(providerId, info)
		return info
	}

	/**
	 * Load-Faktor einer Instanz: 0 = unbekannt/frei, bis 1 = stark belegt.
	 * Ollama meldet VRAM je geladenem Modell (`/api/ps`), relativ zum VRAM-Gesamt.
	 */
	loadFactorOf(providerId: string, modelId: string): number {
		const load = this.loads.get(providerId)
		if (!load || load.loadedModels.length === 0) {
			return 0
		}
		const hit = load.loadedModels.find((m) => m.modelId === modelId)
		if (!hit || hit.memoryBytes === 0) {
			return 0
		}
		const total = load.totalMemoryBytes
		if (!total || total <= 0) {
			return 0.5
		}
		return Math.min(1, hit.memoryBytes / total)
	}

	/* --------------------------------- Instanzen ------------------------------- */

	instances(providerId?: string): InstanceModel[] {
		return listInstances(this.db, providerId)
	}

	/** Instanz-Status setzen (z.B. online nach erfolgreicher Discovery). */
	setInstanceStatus(instanceId: string, status: ProviderStatus): void {
		setInstanceStatus(this.db, instanceId, status)
	}

	/* ------------------------------ Bootstrapping ------------------------------ */

	/**
	 * Alle aktivierten, gespeicherten Provider: registrieren, Health-Check,
	 * initiale Discovery, Polling starten.
	 */
	async bootstrap(): Promise<void> {
		const { listProviders } = await import("../db/repositories.js")
		for (const p of listProviders(this.db)) {
			if (!p.enabled) {
				continue
			}
			try {
				this.register(p.id, p.type, p.baseUrl, p.label)
			} catch (e) {
				this.log(
					"error",
					"bootstrap",
					`Provider ${p.label} nicht registrierbar: ${e instanceof Error ? e.message : String(e)}`,
				)
				continue
			}
			await this.checkHealth(p.id)
			if (this.status(p.id) === "online") {
				await this.refreshDiscovery(p.id).catch((e: unknown) =>
					this.log(
						"error",
						"discovery",
						`initiale Discovery fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
					),
				)
			}
			this.startPolling(p.id)
		}
	}
}
