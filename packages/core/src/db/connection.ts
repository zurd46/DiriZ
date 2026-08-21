/**
 * SQLite-Verbindung (better-sqlite3, synchron & null-config — Plan §4).
 */

import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

export type Db = Database.Database

export function openDatabase(dataDir: string): Db {
	fs.mkdirSync(dataDir, { recursive: true })
	const db = new Database(path.join(dataDir, "diriz.sqlite"))
	db.pragma("journal_mode = WAL")
	db.pragma("foreign_keys = ON")
	return db
}
