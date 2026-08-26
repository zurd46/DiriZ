/**
 * T1-4 Scheduling: geplante & wiederkehrende Tasks.
 *
 * Zwei Zeitarten, ein Prinzip: `next_run_at` ist immer die **bereits
 * berechnete** Fälligkeit. Der Timer tickt nur — er rechnet keine Arithmetik
 * und kennt keine Zeitzone. Wer einen Plan ändert, berechnet die nächste
 * Fälligkeit sofort neu und schreibt sie zurück; der Timer muss nicht
 * «aufwachen» und neu denken.
 *
 * Einmalige Pläne (ein konkretes Datum) tragen ihre Zeit in `next_run_at` und
 * werden nach dem Lauf automatisch deaktiviert — ein Plan, der nur einmal
 * laufen soll, soll auch nur einmal laufen.
 *
 * Der Lauf selbst ist eine normale Task (eigene `scheduleId`-Kennung in den
 * Metadaten): Routing, Failover, Queue und Dashboard gelten wie sonst.
 */
import { randomUUID } from "node:crypto"
import type { CoreEvent } from "@diriz/shared"
import type { Db } from "../db/connection.js"
import { getAgent } from "../db/repositories.js"
import type { ExecutionEngine } from "../execution/engine.js"

/** Ein Zeitplan, wie er in der Datenbank liegt. */
export interface Schedule {
	id: string
	title: string
	prompt: string
	agentId: string | null
	privacy: "local-only" | "allow-cloud"
	pinnedProviderId: string | null
	pinnedModelId: string | null
	/** 5 Felder, lokale Zeit — oder `null` bei Intervallen. */
	cron: string | null
	/** Intervall in Minuten — oder `null` bei Cron/Datum. */
	everyMinutes: number | null
	/** Nächste Fälligkeit (ISO-8601) — das einzige, was der Timer liest. */
	nextRunAt: string | null
	enabled: boolean
	lastRunTaskId: string | null
	lastRunAt: string | null
	createdAt: string
}

interface ScheduleRow {
	id: string
	title: string
	prompt: string
	agent_id: string | null
	privacy: string
	pinned_provider_id: string | null
	pinned_model_id: string | null
	cron: string | null
	every_minutes: number | null
	next_run_at: string | null
	enabled: number
	last_run_task_id: string | null
	last_run_at: string | null
	created_at: string
}

function rowToSchedule(row: ScheduleRow): Schedule {
	return {
		id: row.id,
		title: row.title,
		prompt: row.prompt,
		agentId: row.agent_id,
		privacy: row.privacy === "allow-cloud" ? "allow-cloud" : "local-only",
		pinnedProviderId: row.pinned_provider_id,
		pinnedModelId: row.pinned_model_id,
		cron: row.cron,
		everyMinutes: row.every_minutes,
		nextRunAt: row.next_run_at,
		enabled: row.enabled === 1,
		lastRunTaskId: row.last_run_task_id,
		lastRunAt: row.last_run_at,
		createdAt: row.created_at,
	}
}

export function listSchedules(db: Db): Schedule[] {
	const rows = db
		.prepare(
			`SELECT id, title, prompt, agent_id, privacy, pinned_provider_id, pinned_model_id,
				cron, every_minutes, next_run_at, enabled, last_run_task_id, last_run_at, created_at
			FROM schedules ORDER BY next_run_at IS NULL, next_run_at, title`,
		)
		.all() as ScheduleRow[]
	return rows.map(rowToSchedule)
}

export function getSchedule(db: Db, id: string): Schedule | undefined {
	const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined
	return row ? rowToSchedule(row) : undefined
}

/**
 * Fällige Pläne: aktiv **und** `next_run_at` in der Vergangenheit. Die
 * Fälligkeit wird **vor** dem Lauf vorverschoben (Intervall: + Intervall,
 * Einmalig: `null` + deaktiviert) — ein abgestürzter Core springt beim
 * nächsten Tick nicht auf zehn doppelte Läufe, sondern auf einen.
 */
export function claimDueSchedules(db: Db, nowIso: string, fire: (s: Schedule) => void): number {
	const rows = db
		.prepare(`SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`)
		.all(nowIso) as ScheduleRow[]
	let count = 0
	for (const row of rows.map(rowToSchedule)) {
		let next: string | null
		let stayEnabled = true
		if (row.everyMinutes !== null) {
			next = new Date(Date.parse(row.nextRunAt as string) + row.everyMinutes * 60_000).toISOString()
		} else {
			// Einmalig (Cron-Zeitpunkt oder Datum): nach dem Lauf aus.
			next = null
			stayEnabled = false
		}
		db.prepare(
			`UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?`,
		).run(next, stayEnabled ? 1 : 0, row.id)
		row.nextRunAt = next
		row.enabled = stayEnabled
		count += 1
		try {
			fire(row)
		} catch (e) {
			// Ein einzelner fehlgeschlagener Lauf (z. B. Parallelitäts-Limit)
			// darf nicht den ganzen Tick stoppen — die übrigen Pläne laufen.
			throw e
		}
	}
	return count
}

/* --------------------------- Cron-Arithmetik (5 Felder) -------------------- */

/**
 * Parse 5 Felder (Minute, Stunde, Tag, Monat, Wochentag). Unterstützt die
 * Alltags-Formen: `*`, Zahlen, Listen (`1,15`), Bereiche (`9-17`) und
 * Schrittwerte (`*/5`, `1-10/2`). Keine `?`, keine Namen, keine `L`/`#` —
 * das ist ein Planer für den eigenen Rechner, kein Crontab-Ersatz.
 * Gibt `undefined` zurück bei allem Unbekannten.
 */
function parseField(spec: string, min: number, max: number): number[] | undefined {
	const out: number[] = []
	for (const part of spec.split(",")) {
		const [rangePart, stepPart] = part.split("/")
		const step = stepPart === undefined ? 1 : Number(stepPart)
		if (!Number.isInteger(step) || step < 1) {
			return undefined
		}
		let lo: number
		let hi: number
		if (rangePart === "*") {
			lo = min
			hi = max
		} else if (rangePart.includes("-")) {
			const [a, b] = rangePart.split("-").map(Number)
			if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
				return undefined
			}
			lo = a
			hi = b
		} else {
			lo = hi = Number(rangePart)
			if (!Number.isInteger(lo)) {
				return undefined
			}
		}
		if (lo < min || hi > max) {
			return undefined
		}
		for (let v = lo; v <= hi; v += step) {
			if (!out.includes(v)) {
				out.push(v)
			}
		}
	}
	return out.length > 0 ? out : undefined
}

/**
 * Nächster Lauf eines Cron-Plans **ab** `from` (lokale Zeit des Servers).
 * `undefined`, wenn der Plan ungültig ist — oder (in der Praxis unmöglich,
 * aber defensiv) wenn keine der nächsten 366 Tage passt.
 */
export function nextCronRun(cron: string, from: Date): Date | undefined {
	const fields = cron.trim().split(/\s+/)
	if (fields.length !== 5) {
		return undefined
	}
	const minutes = parseField(fields[0], 0, 59)
	const hours = parseField(fields[1], 0, 23)
	const days = parseField(fields[2], 1, 31)
	const months = parseField(fields[3], 1, 12)
	const weekdays = parseField(fields[4], 0, 6)
	if (!minutes || !hours || !days || !months || !weekdays) {
		return undefined
	}

	const d = new Date(from.getTime())
	d.setSeconds(0, 0)
	d.setMinutes(d.getMinutes() + 1) // «ab now», nicht «ab vorhin»
	// 366 Tage × 1440 Minuten = ~526k Schritte — für den lokalen Planer
	// vernachlässigbar; ein Plan, der nie passt, ist ein kaputter Plan.
	for (let i = 0; i < 366 * 1440; i++) {
		if (months.includes(d.getMonth() + 1) && days.includes(d.getDate()) && weekdays.includes(d.getDay())) {
			if (hours.includes(d.getHours()) && minutes.includes(d.getMinutes())) {
				return d
			}
		}
		d.setMinutes(d.getMinutes() + 1)
	}
	return undefined
}

/* --------------------------------- Scheduler -------------------------------- */

export interface SchedulerDeps {
	db: Db
	engine: ExecutionEngine
	emit: (event: CoreEvent) => void
	log: (level: "info" | "warn" | "error", scope: string, msg: string) => void
	/** Standard 30 s — in Tests kleiner. */
	intervalMs?: number
}

export class Scheduler {
	private timer: NodeJS.Timeout | undefined
	private deps: SchedulerDeps
	/** Läuft gerade ein Lauf? Dampft die Frequenz ab (siehe `tick`). */
	private inFlight = false

	constructor(deps: SchedulerDeps) {
		this.deps = deps
	}

	/**
	 * Ein Tick: fällige Pläne beanspruchen und starten. Synchron — der
	 * Timer-Callback darf nicht mit offenen Promises zurückkommen, und die
		Engine-Akzeptanz (`start`) ist sowieso synchron.
	 */
	tick(nowIso: string = new Date().toISOString()): void {
		if (this.inFlight) {
			return
		}
		this.inFlight = true
		try {
			const count = claimDueSchedules(this.deps.db, nowIso, (s) => {
				this.fireSchedule(s)
			})
			if (count > 0) {
				this.deps.log("info", "schedules", `${count} Plan/Pläne fällig — Task(s) erzeugt`)
			}
		} finally {
			this.inFlight = false
		}
	}

	/** Erzeugt die Task für einen Plan und gibt sie in die Engine. */
	fireSchedule(schedule: Schedule): string | undefined {
		const { db, engine, emit, log } = this.deps
		// Der Spezialist muss noch existieren und aktiv sein — sonst wäre
		// die Task verdammt, bevor sie lief.
		let agentId = schedule.agentId
		if (agentId && !getAgent(db, agentId)?.enabled) {
			log("warn", "schedules", `Plan „${schedule.title}“: Agent ${agentId} fehlt — freies Routing`)
			agentId = undefined
		}
		const meta: Record<string, unknown> = {
			privacy: schedule.privacy,
			mode: schedule.pinnedProviderId || schedule.pinnedModelId ? "pinned" : "auto",
			scheduleId: schedule.id,
			scheduleTitle: schedule.title,
		}
		if (schedule.pinnedProviderId) {
			meta.preferredProviderId = schedule.pinnedProviderId
		}
		if (schedule.pinnedModelId) {
			meta.preferredModelId = schedule.pinnedModelId
		}
		const input = {
			title: schedule.title,
			prompt: schedule.prompt,
			metadata: meta,
			assignmentMode: agentId ? ("agent" as const) : ("auto" as const),
			agentId,
		}
		// `createTask` importiert die Engine nicht — hier bleibt die
		// Abhängigkeitsrichtung sauber.
		const task = createScheduledTask(db, input)
		const result = engine.start(task.id)
		if (!result.accepted) {
			log(
				"warn",
				"schedules",
				`Plan „${schedule.title}“: Start abgelehnt (${result.reason}) — der Plan bleibt fällig und wird beim nächsten Tick erneut versucht`,
			)
			// Nicht gestartet → die Fälligkeit zurückgeben, damit der nächste
			// Tick es erneut versucht statt einen Lauf zu «verloren».
			const wieder = schedule.everyMinutes !== null
				? new Date(Date.now() - schedule.everyMinutes * 60_000).toISOString()
				: new Date(Date.now()).toISOString()
			db.prepare(`UPDATE schedules SET next_run_at = ?, enabled = 1 WHERE id = ?`).run(wieder, schedule.id)
			return undefined
		}
		const jetzt = new Date().toISOString()
		db.prepare(`UPDATE schedules SET last_run_task_id = ?, last_run_at = ? WHERE id = ?`).run(
			task.id,
			jetzt,
			schedule.id,
		)
		emit({ event: "schedule.fired", data: { scheduleId: schedule.id, taskId: task.id, title: schedule.title } })
		return task.id
	}

	start(): void {
		if (this.timer) {
			return
		}
		const intervalMs = this.deps.intervalMs ?? 30_000
		this.timer = setInterval(() => this.tick(), intervalMs)
		// Der Timer darf den Prozess nie offen halten.
		this.timer.unref?.()
		// Sofort einmal prüfen: Pläne, die in der Downtime fällig wurden,
		// laufen beim Start — nicht erst in 30 Sekunden.
		this.tick()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}
}

/**
 * Task-Anlage für einen Plan — bewusst ein eigener Pfad, nicht die
 * `createTask`-Route: Pläne tragen eine `scheduleId`-Kennung in den
 * Metadaten (Dashboard/Verwaltung), und ihre Privacy/Pins kommen aus dem
 * Plan, nicht aus einem Request-Body.
 */
import { createTask } from "../db/repositories.js"

interface ScheduledTaskInput {
	title: string
	prompt: string
	metadata: Record<string, unknown>
	assignmentMode: "auto" | "agent"
	agentId?: string
}

function createScheduledTask(db: Db, input: ScheduledTaskInput) {
	return createTask(db, {
		title: input.title,
		prompt: input.prompt,
		metadata: input.metadata as never,
		assignmentMode: input.assignmentMode,
		agentId: input.agentId,
	})
}

export { randomUUID }
