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
import {
	listInstances,
	recentlyUsedInstances,
	sameServerProviders,
	throughputByInstance,
} from "../db/repositories.js"
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

/** Nach so vielen Fehlversuchen wird ein Modell nicht mehr warm gehalten. */
const MAX_WARM_FAILURES = 2

export class WarmKeeper {
	private timer?: NodeJS.Timeout
	private running = false
	/**
	 * Modelle, die sich nicht warm halten lassen — mit ihrer Fehlerzahl.
	 *
	 * Ein Modell, das der Server nicht laden kann, lässt sich auch beim
	 * fünfzigsten Versuch nicht laden. Beobachtet: 55 identische Fehlschläge
	 * für dasselbe Modell, alle vier Minuten einer, jeder mit einem
	 * Ladeversuch auf der Grafikkarte. Nach zwei Versuchen ist Schluss; ein
	 * Neustart des Cores gibt jedem Modell wieder eine Chance.
	 */
	private erfolglos = new Map<string, number>()

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
			// **Eine Maschine, ein Warmhalten.**
			//
			// `lokalai` (ngrok) und `MacDani` (127.0.0.1) sind derselbe Rechner.
			// Ohne diese Gruppierung wärmte DiriZ dasselbe Modell zweimal an —
			// nachweislich im Abstand von 0,4 Sekunden. Der zweite Ladeversuch
			// trifft auf den ersten, LM Studio bricht beide ab, und für die
			// nächsten Sekunden scheitert dort **jede** Anfrage. Genau davor
			// stand in den Protokollen der Fehlschlag der folgenden Aufgabe.
			const erledigt = new Set<string>()
			for (const providerId of this.deps.registry.providerIds) {
				if (erledigt.has(providerId)) {
					continue
				}
				for (const gleicher of sameServerProviders(this.deps.db, providerId)) {
					erledigt.add(gleicher)
				}
				if (this.deps.isBusy(providerId)) {
					continue
				}
				if (this.deps.registry.status(providerId) !== "online") {
					continue
				}
				for (const modelId of this.targets(providerId, settings.perProvider)) {
					// Was sich zweimal nicht laden liess, lässt sich auch beim
					// fünfzigsten Mal nicht laden — und jeder Versuch belegt die
					// Grafikkarte.
					if ((this.erfolglos.get(`${providerId}:${modelId}`) ?? 0) >= MAX_WARM_FAILURES) {
						continue
					}
					await this.ping(providerId, modelId)
				}
			}
		} finally {
			this.running = false
		}
	}

	/**
	 * Welche Modelle warm bleiben sollen.
	 *
	 * 1. Was **geladen** ist, bleibt geladen — nichts verdrängen.
	 * 2. Sonst: was **zuletzt tatsächlich benutzt** wurde. Ein Modell warm zu
	 *    halten, das niemand ruft, belegt nur Speicher.
	 * 3. Erst wenn es keine Geschichte gibt: das **schnellste gemessene**,
	 *    ersatzweise das mit dem grössten Kontextfenster. Die geratene
	 *    Qualitätsklasse taugt dafür nicht — sie sagt nichts über Nutzung.
	 */
	private targets(providerId: string, limit: number): string[] {
		const geladen = this.deps.registry.loadedModelsOf(providerId)
		if (geladen.length > 0) {
			return geladen.slice(0, limit)
		}
		const jetzt = new Date().toISOString()
		const aktiv = listInstances(this.deps.db, providerId).filter(
			// Ein gesperrtes Modell warm halten zu wollen, heisst: genau den
			// Ladeversuch auslösen, wegen dem es gesperrt wurde.
			(i) => i.enabled && i.capabilities.length > 0 && !(i.lockedUntil && i.lockedUntil > jetzt),
		)
		if (aktiv.length === 0) {
			return []
		}

		const benutzt = recentlyUsedInstances(this.deps.db, providerId, limit)
		if (benutzt.length > 0) {
			return benutzt
				.map((id) => aktiv.find((i) => i.id === id)?.modelId)
				.filter((m): m is string => m !== undefined)
		}

		const tempo = throughputByInstance(this.deps.db)
		return [...aktiv]
			.sort((a, b) => (tempo.get(b.id) ?? 0) - (tempo.get(a.id) ?? 0) || b.contextWindow - a.contextWindow)
			.slice(0, limit)
			.map((i) => i.modelId)
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
			// Geklappt: Ein früherer Fehlschlag zählt nicht mehr — vielleicht war
			// nur gerade kein Speicher frei.
			this.erfolglos.delete(`${providerId}:${modelId}`)
			this.deps.log("info", "warmup", `${modelId} auf ${this.label(providerId)} warm gehalten`)
		} catch (e) {
			// Warmhalten darf nie stören: Ein Fehler wird notiert, nicht geworfen.
			const key = `${providerId}:${modelId}`
			const zahl = (this.erfolglos.get(key) ?? 0) + 1
			this.erfolglos.set(key, zahl)
			this.deps.log(
				"warn",
				"warmup",
				`${modelId} auf ${this.label(providerId)}: ${e instanceof Error ? e.message : String(e)}` +
					(zahl >= MAX_WARM_FAILURES ? " — wird nicht mehr warm gehalten" : ""),
			)
		} finally {
			clearTimeout(stop)
		}
	}

	private label(providerId: string): string {
		return this.deps.registry.labelOf(providerId) ?? providerId
	}
}
