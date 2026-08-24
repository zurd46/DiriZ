/**
 * Versions- und Laufzeit-Auskunft (`GET /api/version`).
 *
 * Die Oberfläche zeigt diese Werte in der Statusleiste — so ist im Betrieb
 * immer sichtbar, welcher Stand tatsächlich läuft. Genau daran erkennt man
 * auch einen versehentlich weiterlaufenden alten Prozess.
 */

import fs from "node:fs"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { getSetting } from "../db/repositories.js"

/** Version aus der `package.json` des Cores — einmal beim Start gelesen. */
function readVersion(): string {
	const candidates = [
		path.resolve(import.meta.dirname, "..", "..", "package.json"), // dist/routes
		path.resolve(import.meta.dirname, "..", "..", "..", "package.json"), // src/routes
	]
	for (const file of candidates) {
		try {
			const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string }
			if (pkg.name?.includes("core") && pkg.version) {
				return pkg.version
			}
		} catch {
			// nächster Kandidat
		}
	}
	return "0.0.0"
}

/**
 * Wann wurde der **laufende** Code gebaut?
 *
 * Die Versionsnummer allein hilft nicht: Sie bleibt `0.1.0`, während sich der
 * Code zwanzigmal ändert. Der Zeitstempel der eigenen Datei verrät dagegen
 * sofort, ob hier noch ein Prozess von vor einer halben Stunde läuft — die
 * häufigste Ursache für „Route existiert nicht“.
 */
function readBuiltAt(): string | undefined {
	try {
		return fs.statSync(import.meta.filename).mtime.toISOString()
	} catch {
		return undefined
	}
}

const VERSION = readVersion()
const STARTED_AT = new Date().toISOString()
const BUILT_AT = readBuiltAt()

export function registerVersion(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/version", () => {
		return {
			name: "DiriZ",
			version: VERSION,
			schemaVersion: getSetting<{ schemaVersion: number }>(ctx.db, "schema_version")?.schemaVersion ?? 0,
			node: process.version,
			startedAt: STARTED_AT,
			builtAt: BUILT_AT,
			uptimeSec: Math.round(process.uptime()),
		}
	})
}
