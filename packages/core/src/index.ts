/**
 * DiriZ Core — Einstiegspunkt.
 *
 * Reihenfolge (Plan §7): Konfiguration → SQLite öffnen → Migrationen →
 * Secret laden → Registry + Engine aufbauen → Provider-Bootstrapping →
 * Fastify starten (127.0.0.1:8787). SIGINT/SIGTERM → sauber beenden.
 */

import { type CoreEvent, workBranchName } from "@diriz/shared"
import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { openDatabase } from "./db/connection.js"
import { migrate } from "./db/migrate.js"
import { getRepo, getSetting, persistLog, providerApiKeyEnc, setTaskRepo } from "./db/repositories.js"
import { refreshCatalogSwarms, seedTeamCatalog } from "./db/seed.js"
import { EventBus } from "./execution/bus.js"
import { ExecutionEngine } from "./execution/engine.js"
import { taskWorktreePath } from "./execution/worktree.js"
import { ensureWorktree } from "./git/repo.js"
import { log, setLogPersist } from "./logger.js"
import { ProviderRegistry } from "./providers/registry.js"
import { findWebDir } from "./routes/webui.js"
import { Feedback } from "./routing/feedback.js"
import { decryptString, loadOrCreateSecret } from "./security/keys.js"

async function main(): Promise<void> {
	const config = loadConfig()
	const db = openDatabase(config.dataDir)
	const schemaVersion = migrate(db)
	// Eingebautes Software-Team anlegen (einmalig, überschreibt nie Eigenes).
	const seeded = seedTeamCatalog(db)
	refreshCatalogSwarms(db)
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
		// Tasks mit gepinntem Repository arbeiten in einem Git-Worktree statt in
		// einem leeren Ordner — das Modell sieht damit das echte Projekt.
		resolveTaskDir: (task) => resolveTaskDir(task),
	})

	async function resolveTaskDir(task: Parameters<typeof taskWorktreePath>[1]): Promise<string> {
		const dir = taskWorktreePath(config.workspaceDir, task)
		if (!task.repoId) {
			return dir
		}
		const repo = getRepo(db, task.repoId)
		if (!repo?.localPath) {
			log("warn", "git", `Task ${task.id}: Repository noch nicht geklont — nutze leeren Arbeitsordner`)
			return dir
		}
		const branch = task.workBranch ?? workBranchName(task.title || task.id)
		const baseBranch = task.baseBranch ?? repo.defaultBranch
		try {
			await ensureWorktree({
				localPath: repo.localPath,
				worktreePath: dir,
				branch,
				baseBranch,
				token: githubTokenFor(),
			})
			setTaskRepo(db, task.id, { workBranch: branch, baseBranch })
		} catch (e) {
			log(
				"error",
				"git",
				`Worktree für Task ${task.id} fehlgeschlagen: ${e instanceof Error ? e.message : e}`,
			)
		}
		return dir
	}

	/** Token für Git-Operationen der Engine (identisch zu den Routen). */
	function githubTokenFor(): string | undefined {
		const enc = getSetting<string>(db, "github_token")
		if (!enc) {
			return undefined
		}
		try {
			return decryptString(enc, secret)
		} catch {
			return undefined
		}
	}

	await registry.bootstrap()

	const app = await buildApp({
		db,
		bus,
		registry,
		engine,
		feedback,
		secret,
		workspaceDir: config.workspaceDir,
		reposDir: config.reposDir,
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
	if (seeded.agents.length > 0 || seeded.swarms.length > 0) {
		log(
			"info",
			"core",
			`Team-Katalog: ${seeded.agents.length} Spezialist(en) und ${seeded.swarms.length} Swarm(s) angelegt`,
		)
	}

	// Startbanner auf stdout: Ohne ihn startet der Server stumm, und man sieht
	// weder Port noch Datenverzeichnis — genau daran erkennt man aber einen
	// versehentlich weiterlaufenden alten Prozess.
	const webDir = findWebDir()
	banner([
		`DiriZ Core  ·  Schema v${schemaVersion}`,
		`  URL         http://${config.host}:${config.port}`,
		`  Oberfläche  ${webDir ?? "nicht gebaut — 'npm run build', in der Entwicklung: http://localhost:5173"}`,
		`  Daten       ${config.dataDir}`,
		`  Workspace   ${config.workspaceDir}`,
		"",
		"  Beenden mit Strg+C",
	])
}

/** Mehrzeilige Ausgabe auf stdout (`console.log` ist im Core per Lint gesperrt). */
function banner(lines: string[]): void {
	process.stdout.write(`\n${lines.join("\n")}\n\n`)
}

/** Startfehler in eine Handlungsanweisung übersetzen statt roher Stacktrace. */
function explainStartupError(e: unknown): string {
	const code = (e as { code?: string } | undefined)?.code
	const config = loadConfig()
	if (code === "EADDRINUSE") {
		return [
			`Port ${config.port} ist bereits belegt — läuft DiriZ schon?`,
			"",
			"  Wer belegt ihn?   lsof -nP -iTCP:" + config.port + " -sTCP:LISTEN",
			"  Anderer Port:     DIRIZ_PORT=8788 npm start",
			"",
			"Achtung: Läuft dort ein älterer Build, beantwortet er Anfragen mit veraltetem Code.",
		].join("\n")
	}
	if (code === "EACCES") {
		return `Keine Berechtigung für Port ${config.port} (Ports unter 1024 brauchen Root). Setze DIRIZ_PORT.`
	}
	return e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)
}

main().catch((e: unknown) => {
	console.error(`\nDiriZ Core konnte nicht starten:\n\n${explainStartupError(e)}\n`)
	process.exit(1)
})
