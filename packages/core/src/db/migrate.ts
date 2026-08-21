/**
 * Versionierte SQL-Migrations (`01-plan.md` §11):
 * `0001_init.sql`, `0002_….sql` — beim Start in der Reihenfolge der
 * Versionsnummer angewendet. Die aktuelle Version landet zusätzlich in
 * `settings` (Plan-Vorgabe), die Migrations-Tabelle ist die Wahrheit.
 */

import fs from "node:fs"
import path from "node:path"
import { log } from "../logger.js"
import type { Db } from "./connection.js"

const defaultMigrationsDir = path.join(import.meta.dirname, "..", "..", "db", "migrations")

export function migrate(db: Db, migrationsDir: string = defaultMigrationsDir): number {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	)
	const applied = new Set(
		(db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
			(r) => r.version,
		),
	)
	const files = fs
		.readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))

	let latest = 0
	for (const file of files) {
		const m = file.match(/^(\d+)_/)
		if (!m) {
			continue
		}
		const version = Number(m[1])
		if (applied.has(version)) {
			latest = Math.max(latest, version)
			continue
		}
		const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8")
		const apply = db.transaction(() => {
			db.exec(sql)
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				version,
				file,
				new Date().toISOString(),
			)
		})
		apply()
		latest = Math.max(latest, version)
		log("info", "db", `Migration ${file} angewendet`)
	}

	// Plan §11: Schema-Version zusätzlich in `settings`.
	if (latest > 0) {
		db.prepare(
			"INSERT INTO settings (key, value_json) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
		).run(JSON.stringify({ schemaVersion: latest }))
	}
	return latest
}
