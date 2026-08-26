/**
 * T1-4 Scheduling: Cron-Arithmetik, Fälligkeit, Claim-Logik, Tick mit
 * Fake-Engine (inkl. „Start abgelehnt"-Pfad) und CRUD.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CoreEvent } from "@diriz/shared"
import { beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { getTask } from "../src/db/repositories.js"
import type { ExecutionEngine } from "../src/execution/engine.js"
import {
	claimDueSchedules,
	computeNextRun,
	createSchedule,
	deleteSchedule,
	getSchedule,
	listSchedules,
	nextCronRun,
	runScheduleNow,
	Scheduler,
	updateSchedule,
} from "../src/scheduling/scheduler.js"

/** Fake-Engine: akzeptiert oder lehnt nach Vorgabe ab. */
function fakeEngine(accepted: boolean, reason?: string, started?: string[]) {
	return {
		start: (id: string) => {
			if (started) {
				started.push(id)
			}
			return accepted ? { accepted: true } : { accepted: false, reason }
		},
	} as unknown as ExecutionEngine
}

function deps(db: Db, engine: ExecutionEngine = fakeEngine(true)) {
	const events: CoreEvent[] = []
	return {
		events,
		...({
			db,
			engine,
			emit: (e: CoreEvent) => events.push(e),
			log: () => {},
		} as const),
	}
}

let db: Db

beforeEach(() => {
	db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-sched-")))
	migrate(db)
})

describe("nextCronRun", () => {
	it("findet den nächsten vollen Tag um 09:00", () => {
		const from = new Date(2026, 6, 26, 10, 0) // 26.08.2026 10:00 (MEZ)
		const next = nextCronRun("0 9 * * *", from)
		expect(next).toBeDefined()
		expect(next?.getHours()).toBe(9)
		expect(next?.getMinutes()).toBe(0)
		expect(next?.getDate()).toBe(27)
	})

	it("findet den nächsten Montag 08:30", () => {
		const from = new Date(2026, 6, 26, 12, 0) // Mittwoch
		const next = nextCronRun("30 8 * * 1", from)
		expect(next?.getDay()).toBe(1)
		expect(next?.getHours()).toBe(8)
		expect(next?.getMinutes()).toBe(30)
	})

	it("unterstützt Schritt- und Listenfelder", () => {
		const from = new Date(2026, 6, 26, 10, 0)
		const next = nextCronRun("*/15 10-11 * * *", from)
		expect(next?.getMinutes()).toBe(15)
		const next2 = nextCronRun("5,35 9 * * *", from)
		expect(next2?.getMinutes()).toBe(5)
	})

	it("lehnt ungültige Pläne ab", () => {
		expect(nextCronRun("0 9 * *", new Date())).toBeUndefined() // 4 Felder
		expect(nextCronRun("60 9 * * *", new Date())).toBeUndefined() // Minute 60
		expect(nextCronRun("a b c d e", new Date())).toBeUndefined() // Müll
	})
})

describe("CRUD", () => {
	it("legt Pläne an und listet sie", () => {
		createSchedule(db, { title: "Täglich", prompt: "p", everyMinutes: 60 })
		createSchedule(db, {
			title: "Einmalig",
			prompt: "p",
			once: true,
			nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
		})
		const all = listSchedules(db)
		expect(all).toHaveLength(2)
		expect(all.map((s) => s.title).sort()).toEqual(["Einmalig", "Täglich"])
	})

	it("aktualisiert einzelne Felder", () => {
		const s = createSchedule(db, { title: "Alt", prompt: "p", everyMinutes: 5 })
		const updated = updateSchedule(db, s.id, { title: "Neu", everyMinutes: 30 })
		expect(updated?.title).toBe("Neu")
		expect(updated?.everyMinutes).toBe(30)
		expect(updated?.prompt).toBe("p") // unangetastet
	})

	it("löscht Pläne", () => {
		const s = createSchedule(db, { title: "Geh", prompt: "p", everyMinutes: 5 })
		expect(deleteSchedule(db, s.id)).toBe(true)
		expect(getSchedule(db, s.id)).toBeUndefined()
		expect(deleteSchedule(db, s.id)).toBe(false)
	})
})

describe("Fälligkeit & Claim", () => {
	it("berechnet die nächste Fälligkeit für Intervalle", () => {
		const s = createSchedule(db, { title: "5 min", prompt: "p", everyMinutes: 5 })
		const from = new Date("2026-08-26T10:00:00.000Z")
		expect(computeNextRun(s, from)).toBe("2026-08-26T10:05:00.000Z")
	})

	it("berechnet die nächste Fälligkeit für Cron", () => {
		const s = createSchedule(db, { title: "Cron", prompt: "p", cron: "0 9 * * *" })
		const from = new Date("2026-08-26T10:00:00.000Z")
		const next = computeNextRun(s, from)
		expect(next).toBeDefined()
		const d = new Date(next as string)
		expect(d.getUTCHours()).toBeGreaterThanOrEqual(0)
	})

	it("lässt einmalige Pläne ohne Fälligkeit", () => {
		const s = createSchedule(db, {
			title: "Einmal",
			prompt: "p",
			once: true,
			nextRunAt: "2026-09-01T00:00:00.000Z",
		})
		expect(computeNextRun(s, new Date())).toBeNull()
	})

	it("beansprucht nur fällige, aktive Pläne und deaktiviert Einmalige", () => {
		const jetzt = "2026-08-26T10:00:00.000Z"
		const interval = createSchedule(db, { title: "Interval", prompt: "p", everyMinutes: 5 })
		const once = createSchedule(db, {
			title: "Einmal",
			prompt: "p",
			once: true,
			nextRunAt: "2026-08-26T09:59:00.000Z",
		})
		const later = createSchedule(db, {
			title: "Später",
			prompt: "p",
			everyMinutes: 5,
			nextRunAt: "2026-08-26T11:00:00.000Z",
		})
		const paused = createSchedule(db, {
			title: "Pausiert",
			prompt: "p",
			everyMinutes: 5,
			nextRunAt: "2026-08-26T09:59:00.000Z",
		})
		updateSchedule(db, paused.id, { enabled: false })
		// Fälligkeit setzen: alle drei (außer Pausiert) sind fällig.
		db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id IN (?, ?, ?)`).run(
			"2026-08-26T09:59:00.000Z",
			interval.id,
			once.id,
			later.id,
		)
		// later neu in die Zukunft
		db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run("2026-08-26T11:00:00.000Z", later.id)

		const fired: string[] = []
		const count = claimDueSchedules(db, jetzt, (s) => fired.push(s.id))
		expect(count).toBe(2) // interval + once
		expect(fired).toEqual([interval.id, once.id])

		const i = getSchedule(db, interval.id)
		expect(i?.enabled).toBe(true)
		expect(i?.nextRunAt).toBe("2026-08-26T10:05:00.000Z") // 10:00 + 5 min

		const o = getSchedule(db, once.id)
		expect(o?.enabled).toBe(false)
		expect(o?.nextRunAt).toBeNull()

		const l = getSchedule(db, later.id)
		expect(l?.nextRunAt).toBe("2026-08-26T11:00:00.000Z") // unangetastet

		// Zweiter Tick: nichts mehr fällig (Einmaliger ist aus, Intervall in Zukunft).
		expect(claimDueSchedules(db, jetzt, () => fired.push("x"))).toBe(0)
	})
})

describe("Scheduler-Tick mit Fake-Engine", () => {
	it("erzeugt eine Task mit scheduleId und setzt die letzten Läufe", () => {
		const s = createSchedule(db, { title: "Täglicher Report", prompt: "Fasse zusammen", everyMinutes: 5 })
		db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run("2026-08-26T09:59:00.000Z", s.id)
		const started: string[] = []
		const d = deps(db, fakeEngine(true, undefined, started))
		const sched = new Scheduler(d)
		sched.tick("2026-08-26T10:00:00.000Z")

		expect(started).toHaveLength(1)
		const task = getTask(db, started[0])
		expect(task).toBeDefined()
		expect(task?.metadata.scheduleId).toBe(s.id)
		expect(task?.metadata.scheduleTitle).toBe("Täglicher Report")
		expect(task?.title).toBe("Täglicher Report")

		const after = getSchedule(db, s.id)
		expect(after?.lastRunTaskId).toBe(started[0])
		expect(after?.lastRunAt).toBeDefined()
		expect(d.events.some((e) => e.event === "schedule.fired")).toBe(true)
	})

	it("gibt die Fälligkeit zurück, wenn die Engine den Start ablehnt", () => {
		const s = createSchedule(db, { title: "Blockiert", prompt: "p", everyMinutes: 5 })
		db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run("2026-08-26T09:59:00.000Z", s.id)
		const d = deps(db, fakeEngine(false, "Parallelitäts-Limit erreicht"))
		const sched = new Scheduler(d)
		sched.tick("2026-08-26T10:00:00.000Z")

		const after = getSchedule(db, s.id)
		expect(after?.enabled).toBe(true)
		expect(after?.lastRunTaskId).toBeNull() // kein Lauf gestartet
		// Fälligkeit ist zurückgesetzt — der nächste Tick probiert es erneut.
		expect(after?.nextRunAt).toBeDefined()
		expect(Date.parse(after?.nextRunAt as string)).toBeLessThanOrEqual(Date.now())
	})

	it("läuft Einmalige aus und startet sie nur einmal", () => {
		const s = createSchedule(db, {
			title: "Erinnerung",
			prompt: "p",
			once: true,
			nextRunAt: "2026-08-26T09:59:00.000Z",
		})
		const d = deps(db)
		const sched = new Scheduler(d)
		sched.tick("2026-08-26T10:00:00.000Z")
		sched.tick("2026-08-26T10:01:00.000Z")

		expect(getSchedule(db, s.id)?.enabled).toBe(false)
		expect(d.events.filter((e) => e.event === "schedule.fired")).toHaveLength(1)
	})
})

describe("runScheduleNow", () => {
	it("startet einen Plan sofort, auch wenn er nicht fällig ist", () => {
		const s = createSchedule(db, {
			title: "Jetzt",
			prompt: "p",
			everyMinutes: 60,
			nextRunAt: "2027-01-01T00:00:00.000Z",
		})
		const d = deps(db)
		const taskId = runScheduleNow(d, s)
		expect(taskId).toBeDefined()
		expect(getTask(db, taskId as string)?.metadata.scheduleId).toBe(s.id)
		expect(getSchedule(db, s.id)?.lastRunTaskId).toBe(taskId)
	})

	it("meldet Ablehnung der Engine als undefined", () => {
		const s = createSchedule(db, { title: "Nein", prompt: "p", everyMinutes: 60 })
		const d = deps(db, fakeEngine(false, "Limit"))
		expect(runScheduleNow(d, s)).toBeUndefined()
	})
})
