/**
 * Aufbewahrung: Was alt genug ist, verschwindet — und nur das.
 *
 * Der Test prüft beide Richtungen: dass Altlasten wirklich fallen **und** dass
 * die Geschichte des Systems (Tasks, Ausführungen, Bewertungen) bleibt. Eine
 * Aufräumregel, die zu viel mitnimmt, ist schlimmer als keine.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createExecution, createTask } from "../src/db/repositories.js"
import { purgeOldData } from "../src/db/retention.js"

let db: Db
let alteExecution: string
let neueExecution: string

const vorTagen = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

beforeAll(() => {
	db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-retention-")))
	migrate(db)

	const task = createTask(db, { prompt: "Aufräum-Test" })
	alteExecution = createExecution(db, { taskId: task.id }).id
	neueExecution = createExecution(db, { taskId: task.id }).id
	db.prepare("UPDATE executions SET started_at = ? WHERE id = ?").run(vorTagen(90), alteExecution)
	db.prepare("UPDATE executions SET started_at = ? WHERE id = ?").run(vorTagen(1), neueExecution)

	for (const id of [alteExecution, neueExecution]) {
		db.prepare(
			"INSERT INTO execution_chunks (execution_id, seq, delta, created_at) VALUES (?, 1, 'x', ?)",
		).run(id, new Date().toISOString())
	}
	db.prepare("INSERT INTO logs (ts, level, scope, message) VALUES (?, 'info', 'test', 'alt')").run(
		vorTagen(90),
	)
	db.prepare("INSERT INTO logs (ts, level, scope, message) VALUES (?, 'info', 'test', 'neu')").run(
		vorTagen(1),
	)
	db.prepare(
		"INSERT INTO metrics_hourly (bucket, provider_id, kind, value) VALUES (?, 'p', 'tokens', 1)",
	).run(vorTagen(400))
})

describe("purgeOldData", () => {
	it("löscht Altes und lässt Junges stehen", () => {
		const res = purgeOldData(db, { logDays: 14, chunkDays: 30, metricsDays: 180 })
		expect(res.logs).toBe(1)
		expect(res.chunks).toBe(1)
		expect(res.metrics).toBe(1)

		const logs = db.prepare("SELECT message FROM logs").all() as { message: string }[]
		expect(logs.map((l) => l.message)).toEqual(["neu"])

		// Die Schnipsel der jungen Ausführung bleiben — sie zeigen den Verlauf.
		const chunks = db.prepare("SELECT execution_id FROM execution_chunks").all() as {
			execution_id: string
		}[]
		expect(chunks.map((c) => c.execution_id)).toEqual([neueExecution])
	})

	it("rührt die Geschichte des Systems nicht an", () => {
		// Tasks und Ausführungen bleiben — auch die alte: Sie begründet, warum
		// ein Modell gewählt wurde, und trägt ihre Bewertung.
		expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1)
		expect((db.prepare("SELECT COUNT(*) AS n FROM executions").get() as { n: number }).n).toBe(2)
	})

	it("ist wiederholbar und meldet dann nichts mehr", () => {
		const res = purgeOldData(db, { logDays: 14, chunkDays: 30, metricsDays: 180 })
		expect(res.logs + res.chunks + res.metrics).toBe(0)
	})
})
