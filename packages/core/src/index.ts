/**
 * DiriZ Core — Einstiegspunkt.
 *
 * Reihenfolge (Plan §7): Konfiguration → SQLite öffnen → Migrationen →
 * Secret laden → Registry + Engine aufbauen → Provider-Bootstrapping →
 * Fastify starten (127.0.0.1:8787). SIGINT/SIGTERM → sauber beenden.
 */

import type { CoreEvent } from "@diriz/shared"
import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { openDatabase } from "./db/connection.js"
import { migrate } from "./db/migrate.js"
import { persistLog, providerApiKeyEnc } from "./db/repositories.js"
import { EventBus } from "./execution/bus.js"
import { ExecutionEngine } from "./execution/engine.js"
import { log, setLogPersist } from "./logger.js"
import { ProviderRegistry } from "./providers/registry.js"
import { Feedback } from "./routing/feedback.js"
import { decryptString, loadOrCreateSecret } from "./security/keys.js"

async function main(): Promise<void> {
	const config = loadConfig()
	const db = openDatabase(config.dataDir)
	const schemaVersion = migrate(db)
	const secret = loadOrCreateSecret(config.dataDir)

	const bus = new EventBus()
	const emit = (event: CoreEvent): void => {
		bus.emit(event)
	}
	const logFn = (level: Parameters<typeof log>[0], scope: string, msg: string): void => {
		log(level, scope, msg)
	}

	// Log-Persistenz + Live-Log-Events im SSE-Stream.
	setLogPersist((entry) => {
		try {
			persistLog(db, entry)
		} catch {
			// Logging darf nie den Core reissen.
		}
		bus.emit({ event: "log", data: { level: entry.level, scope: entry.scope, msg: entry.msg } })
	})

	const registry = new ProviderRegistry(db, emit, logFn, (providerId) => {
		const enc = providerApiKeyEnc(db, providerId)
		if (!enc) {
			return undefined
		}
		try {
			return decryptString(enc, secret)
		} catch {
			log("error", "security", `API-Key für ${providerId} nicht entschlüsselbar`)
			return undefined
		}
	})

	const feedback = new Feedback()
	const engine = new ExecutionEngine({
		db,
		registry,
		feedback,
		emit,
		log: logFn,
		workspaceDir: config.workspaceDir,
	})

	await registry.bootstrap()

	const app = await buildApp({
		db,
		bus,
		registry,
		engine,
		feedback,
		secret,
		workspaceDir: config.workspaceDir,
	})

	let shuttingDown = false
	const shutdown = (signal: string) => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		log("info", "core", `${signal} — beende DiriZ Core …`)
		registry.stopAllPolling()
		void app.close().finally(() => {
			db.close()
			process.exit(0)
		})
	}
	process.on("SIGINT", () => shutdown("SIGINT"))
	process.on("SIGTERM", () => shutdown("SIGTERM"))

	await app.listen({ host: config.host, port: config.port })
	log(
		"info",
		"core",
		`DiriZ Core läuft auf http://${config.host}:${config.port} (Schema v${schemaVersion}, Data: ${config.dataDir})`,
	)
}

main().catch((e: unknown) => {
	console.error("Fehler beim Starten des DiriZ Core:", e)
	process.exit(1)
})
