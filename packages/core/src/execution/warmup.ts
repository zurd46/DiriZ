/**
 * Modelle warm halten.
 *
 * Ein lokales 30-B-Modell braucht beim ersten Aufruf Minuten, bis es im
 * Grafikspeicher liegt — und genau diese Minuten sehen aus, als sei DiriZ
 * eingefroren. Danach ist es warm und antwortet sofort. LM Studio und Ollama
 * werfen ein Modell nach einer Weile Untätigkeit wieder raus; ein winziger
 * Aufruf in regelmässigem Abstand verhindert das.
 *
 * Zwei Regeln, sonst richtet das Warmhalten mehr Schaden an als Nutzen:
 *
 *  1. **Nie einem laufenden Auftrag in die Quere kommen.** Arbeitet der Rechner
 *     gerade, wird er übersprungen — ein Warmhalte-Ping würde dort nur um
 *     Rechenzeit konkurrieren.
 *  2. **Nie ein fremdes Modell verdrängen.** Liegt bereits etwas auf der Karte,
 *     wird genau das warm gehalten. Nur wenn nichts geladen ist, wird ein
 *     Modell ausgewählt — sonst würde bei `maxModelsPerProvider: 1` jeder Ping
 *     einen Ladevorgang auslösen und die Karte pausenlos umwälzen.
 */

import type { Db } from "../db/connection.js"
import { getInstanceSpec, listInstances } from "../db/repositories.js"
import type { ProviderRegistry } from "../providers/registry.js"

type LogFn = (level: "info" | "warn" | "error", scope: string, msg: string) => void

/** Einstellungen (`settings.warmup`). */
export interface WarmupSettings {
	enabled: boolean
	/** Abstand zwischen zwei Runden. Kürzer als die Auslagerungsfrist der Server. */
	intervalMinutes: number
	/** Wie viele Modelle je Rechner warm bleiben sollen. */
	perProvider: number
}

export const DEFAULT_WARMUP: WarmupSettings = { enabled: true, intervalMinutes: 4, perProvider: 1 }

export interface WarmKeeperDeps {
	db: Db
	registry: ProviderRegistry
	log: LogFn
	/** Arbeitet dieser Rechner gerade? Dann wird er übersprungen. */
	isBusy: (providerId: string) => boolean
	settings: () => WarmupSettings
}

export class WarmKeeper {
	private timer?: NodeJS.Timeout
	private running = false

	constructor(private readonly deps: WarmKeeperDeps) {}

	start(): void {
		if (this.timer) {
			return
		}
		const tick = () => {
			void this.runOnce()
		}
		const minutes = Math.max(1, this.deps.settings().intervalMinutes)
		this.timer = setInterval(tick, minutes * 60_000)
		// Nicht sofort: Beim Start laufen Health-Check und Discovery — ein
		// Warmhalte-Ping mittendrin verzögert nur das erste Bild.
		setTimeout(tick, 20_000).unref?.()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	/** Eine Runde: je Rechner die passenden Modelle antippen. */
	async runOnce(): Promise<void> {
		const settings = this.deps.settings()
		if (!settings.enabled || this.running) {
			return
		}
		this.running = true
		try {
			for (const providerId of this.deps.registry.providerIds) {
				if (this.deps.isBusy(providerId)) {
					continue
				}
				if (this.deps.registry.status(providerId) !== "online") {
					continue
				}
				for (const modelId of this.targets(providerId, settings.perProvider)) {
					await this.ping(providerId, modelId)
				}
			}
		} finally {
			this.running = false
		}
	}

	/**
	 * Welche Modelle warm bleiben sollen: die bereits geladenen — sonst die
	 * besten aktiven dieses Rechners (Qualitätsklasse aus dem `llm.md`, bei
	 * Gleichstand das grössere Kontextfenster).
	 */
	private targets(providerId: string, limit: number): string[] {
		const geladen = this.deps.registry.loadedModelsOf(providerId)
		if (geladen.length > 0) {
			return geladen.slice(0, limit)
		}
		const RANG = { hoch: 3, mittel: 2, niedrig: 1 } as const
		return listInstances(this.deps.db, providerId)
			.filter((i) => i.enabled && i.capabilities.length > 0)
			.map((i) => ({ i, rang: RANG[getInstanceSpec(this.deps.db, i.id)?.quality ?? "mittel"] }))
			.sort((a, b) => b.rang - a.rang || b.i.contextWindow - a.i.contextWindow)
			.slice(0, limit)
			.map((x) => x.i.modelId)
	}

	/** Ein Ein-Token-Aufruf: Er hält das Modell geladen und kostet nichts. */
	private async ping(providerId: string, modelId: string): Promise<void> {
		const adapter = this.deps.registry.adapter(providerId)
		if (!adapter) {
			return
		}
		const controller = new AbortController()
		const stop = setTimeout(() => controller.abort(), 120_000)
		try {
			const stream = adapter.chat({
				messages: [{ role: "user", content: "ok" }],
				model: modelId,
				// Die einzige Stelle, an der DiriZ eine Obergrenze setzt: Hier ist
				// die Antwort egal, nur das Laden zählt.
				settings: { maxTokens: 1, temperature: 0 },
				signal: controller.signal,
			})
			for await (const chunk of stream) {
				if (chunk.type === "done") {
					break
				}
			}
			this.deps.log("info", "warmup", `${modelId} auf ${this.label(providerId)} warm gehalten`)
		} catch (e) {
			// Warmhalten darf nie stören: Ein Fehler wird notiert, nicht geworfen.
			this.deps.log(
				"warn",
				"warmup",
				`${modelId} auf ${this.label(providerId)}: ${e instanceof Error ? e.message : String(e)}`,
			)
		} finally {
			clearTimeout(stop)
		}
	}

	private label(providerId: string): string {
		return this.deps.registry.labelOf(providerId) ?? providerId
	}
}
