/**
 * T1-4 Scheduling: geplante & wiederkehrende Tasks.
 *
 * Drei Planarten, ein Prinzip — `next_run_at` ist immer die **bereits
 * berechnete** Fälligkeit. Der Timer tickt nur, rechnet keine Arithmetik
 * und kennt keine Zeitzone. Wer einen Plan anlegt oder ändert, berechnet
 * die nächste Fälligkeit sofort und schreibt sie zurück.
 *
 *   • einmalig  → `once=1`, Zeit in `next_run_at`; nach dem Lauf `enabled=0`
 *   • Intervall → `every_minutes=n`; nach dem Lauf `next_run_at = jetzt + n`
 *   • Cron      → `cron="m h dom mon dow"`; nach dem Lauf neu berechnet
 *
 * Jeder Lauf ist eine normale Task (mit `scheduleId` in den Metadaten):
 * Routing, Failover, Queue und Dashboard gelten wie sonst.
 */

import { randomUUID } from "node:crypto"
import type { CoreEvent } from "@diriz/shared"
import type { Db } from "../db/connection.js"
import { createTask, getAgent } from "../db/repositories.js"
import type { ExecutionEngine } from "../execution/engine.js"

/* ------------------------------- Typen ------------------------------------ */

export interface Schedule {
	id: string
	title: string
	prompt: string
	agentId: string | null
	privacy: "local-only" | "allow-cloud"
	pinnedProviderId: string | null
	pinnedModelId: string | null
	/** 5 Felder (Minute, Stunde, Tag, Monat, Wochentag) — oder `null`. */
	cron: string | null
	/** Intervall in Minuten — oder `null`. */
	everyMinutes: number | null
	/** `1` = einmaliger Plan, `0` = wiederkehrend. */
	once: boolean
	/** Nächste Fälligkeit (ISO-8601) — das einzige, was der Timer liest. */
	nextRunAt: string | null
	enabled: boolean
	lastRunTaskId: string | null
	lastRunAt: string | null
	createdAt: string
}

/** Eingabe für `createSchedule`. */
export interface ScheduleInput {
	title: string
	prompt: string
	agentId?: string
	privacy?: "local-only" | "allow-cloud"
	pinnedProviderId?: string
	pinnedModelId?: string
	cron?: string
	everyMinutes?: number
	once?: boolean
	/** ISO-Zeitstempel für einmalige Pläne; bei Intervall/Cron wird berechnet. */
	nextRunAt?: string
	enabled?: boolean
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
	once: number
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
		once: row.once === 1,
		nextRunAt: row.next_run_at,
		enabled: row.enabled === 1,
		lastRunTaskId: row.last_run_task_id,
		lastRunAt: row.last_run_at,
		createdAt: row.created_at,
	}
}

/* ------------------------------- CRUD ------------------------------------- */

export function listSchedules(db: Db): Schedule[] {
	const rows = db
		.prepare(
			`SELECT * FROM schedules
			ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, title`,
		)
		.all() as ScheduleRow[]
	return rows.map(rowToSchedule)
}

export function getSchedule(db: Db, id: string): Schedule | undefined {
	const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined
	return row ? rowToSchedule(row) : undefined
}

export function createSchedule(db: Db, input: ScheduleInput): Schedule {
	const id = randomUUID()
	const now = new Date().toISOString()
	const once = input.once ?? false
	const nextRunAt =
		input.nextRunAt ??
		(input.everyMinutes
			? new Date(Date.now() + input.everyMinutes * 60_000).toISOString()
			: input.cron
				? nextCronRun(input.cron, new Date())?.toISOString()
				: undefined)
	db.prepare(
		`INSERT INTO schedules (id, title, prompt, agent_id, privacy, pinned_provider_id,
			pinned_model_id, cron, every_minutes, once, next_run_at, enabled, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.title,
		input.prompt,
		input.agentId ?? null,
		input.privacy ?? "local-only",
		input.pinnedProviderId ?? null,
		input.pinnedModelId ?? null,
		input.cron ?? null,
		input.everyMinutes ?? null,
		once ? 1 : 0,
		nextRunAt ?? null,
		input.enabled === false ? 0 : 1,
		now,
	)
	const created = getSchedule(db, id)
	if (!created) {
		throw new Error("schedule create failed")
	}
	return created
}

/** Teilweise Aktualisierung — nur die übergebenen Felder werden geschrieben. */
export function updateSchedule(
	db: Db,
	id: string,
	patch: Partial<Omit<ScheduleInput, "title" | "prompt">> & { title?: string; prompt?: string },
): Schedule | undefined {
	const existing = getSchedule(db, id)
	if (!existing) {
		return undefined
	}
	const fields: string[] = []
	const values: unknown[] = []

	const set = (col: string, val: unknown) => {
		fields.push(`${col} = ?`)
		values.push(val)
	}

	if (patch.title !== undefined) set("title", patch.title)
	if (patch.prompt !== undefined) set("prompt", patch.prompt)
	if (patch.agentId !== undefined) set("agent_id", patch.agentId)
	if (patch.privacy !== undefined) set("privacy", patch.privacy)
	if (patch.pinnedProviderId !== undefined) set("pinned_provider_id", patch.pinnedProviderId)
	if (patch.pinnedModelId !== undefined) set("pinned_model_id", patch.pinnedModelId)
	if (patch.cron !== undefined) set("cron", patch.cron)
	if (patch.everyMinutes !== undefined) set("every_minutes", patch.everyMinutes)
	if (patch.once !== undefined) set("once", patch.once ? 1 : 0)
	if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0)
	if (patch.nextRunAt !== undefined) set("next_run_at", patch.nextRunAt)

	if (fields.length === 0) {
		return existing
	}
	values.push(id)
	db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...(values as [unknown]))
	return getSchedule(db, id)
}

export function deleteSchedule(db: Db, id: string): boolean {
	return (db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes ?? 0) > 0
}

/* ------------------------- Fälligkeit berechnen ---------------------------- */

/**
 * Berechnet die nächste Fälligkeit für einen Plan, der gerade abgelaufen
 * ist — wird nach jedem Lauf aufgerufen.
 */
export function computeNextRun(schedule: Schedule, from: Date = new Date()): string | null {
	if (schedule.everyMinutes !== null) {
		return new Date(from.getTime() + schedule.everyMinutes * 60_000).toISOString()
	}
	if (schedule.cron) {
		return nextCronRun(schedule.cron, from)?.toISOString() ?? null
	}
	// Einmalig: keine nächste Fälligkeit.
	return null
}

/* --------------------------- Cron-Arithmetik (5 Felder) -------------------- */

/**
 * Parse ein Cron-Feld: `*`, Zahlen, Listen (`1,15`), Bereiche (`9-17`) und
 * Schrittwerte (Stern-slash-5, `1-10/2`). Keine Namen, keine `?`, keine
 * `L`/`#` — ein Planer für den eigenen Rechner, kein Crontab-Ersatz.
 * `undefined` bei allem Unbekannten.
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
 * `undefined`, wenn der Plan ungültig ist oder in 366 Tagen nichts passt —
 * ein Plan, der nie passt, ist ein kaputter Plan.
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
	d.setMinutes(d.getMinutes() + 1) // «ab jetzt», nicht «ab vorhin»
	for (let i = 0; i < 366 * 1440; i++) {
		if (
			months.includes(d.getMonth() + 1) &&
			days.includes(d.getDate()) &&
			weekdays.includes(d.getDay()) &&
			hours.includes(d.getHours()) &&
			minutes.includes(d.getMinutes())
		) {
			return d
		}
		d.setMinutes(d.getMinutes() + 1)
	}
	return undefined
}

/* --------------------------- Fällige Pläne beanspruchen -------------------- */

/**
 * Erzeugt die Task für einen Plan und übergibt sie an die Engine — als
 * eigenständige Funktion, damit auch die `run-now`-Route sie nutzen kann,
 * ohne einen Scheduler-Instanz zu brauchen.
 *
 * Gibt die Task-ID zurück oder `undefined`, wenn der Start abgelehnt wurde
 * (Parallelitäts-Limit o. Ä.) — in dem Fall wird die Fälligkeit zurückgesetzt.
 */
export function runScheduleNow(deps: SchedulerDeps, schedule: Schedule): string | undefined {
	const { db, engine, emit, log } = deps
	// Der Spezialist muss noch existieren und aktiv sein — sonst wäre
	// die Task verdammt, bevor sie lief. Fallback: freies Routing.
	let agentId: string | undefined = schedule.agentId ?? undefined
	if (agentId && !getAgent(db, agentId)?.enabled) {
		log("warn", "schedules", `Plan „${schedule.title}“: Agent ${agentId} fehlt — freies Routing`)
		agentId = undefined
	}
	const pinned = Boolean(schedule.pinnedProviderId || schedule.pinnedModelId)
	const task = createTask(db, {
		title: schedule.title,
		prompt: schedule.prompt,
		metadata: {
			privacy: schedule.privacy,
			mode: pinned ? "pinned" : "auto",
			preferredProviderId: schedule.pinnedProviderId ?? undefined,
			preferredModelId: schedule.pinnedModelId ?? undefined,
			scheduleId: schedule.id,
			scheduleTitle: schedule.title,
		},
		assignmentMode: agentId ? "agent" : "auto",
		agentId,
	})
	const result = engine.start(task.id)
	if (!result.accepted) {
		// Nicht gestartet → die Fälligkeit zurückgeben (jetzt = sofort
		// fällig wieder), damit der nächste Tick es erneut versucht.
		const jetzt = new Date().toISOString()
		db.prepare(`UPDATE schedules SET next_run_at = ?, enabled = 1 WHERE id = ?`).run(jetzt, schedule.id)
		log(
			"warn",
			"schedules",
			`Plan „${schedule.title}“: Start abgelehnt (${result.reason}) — wird beim nächsten Tick erneut versucht`,
		)
		return undefined
	}
	const jetzt = new Date().toISOString()
	db.prepare(`UPDATE schedules SET last_run_task_id = ?, last_run_at = ? WHERE id = ?`).run(
		task.id,
		jetzt,
		schedule.id,
	)
	emit({
		event: "schedule.fired",
		data: { scheduleId: schedule.id, taskId: task.id, title: schedule.title },
	} satisfies CoreEvent)
	return task.id
}

/**
 * Fällige Pläne: aktiv **und** `next_run_at` ≤ jetzt. Die Fälligkeit wird
 * **vor** dem Lauf vorverschoben (Intervall: + Intervall, Einmalig:
 * `null` + deaktiviert) — ein abgestürzter Core springt beim nächsten Tick
 * nicht auf zehn doppelte Läufe, sondern auf einen.
 */
export function claimDueSchedules(db: Db, nowIso: string, fire: (s: Schedule) => void): number {
	const rows = db
		.prepare(
			`SELECT * FROM schedules
			WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
		)
		.all(nowIso) as ScheduleRow[]
	let count = 0
	for (const schedule of rows.map(rowToSchedule)) {
		const next = computeNextRun(schedule, new Date(nowIso))
		const stayEnabled = !schedule.once
		db.prepare(`UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?`).run(
			next,
			stayEnabled ? 1 : 0,
			schedule.id,
		)
		schedule.nextRunAt = next
		schedule.enabled = stayEnabled
		count += 1
		fire(schedule)
	}
	return count
}

/* --------------------------------- Scheduler -------------------------------- */

export interface SchedulerDeps {
	db: Db
	engine: ExecutionEngine
	emit: (event: CoreEvent) => void
	log: (level: "info" | "warn" | "error", scope: string, msg: string) => void
}

export class Scheduler {
	private timer: NodeJS.Timeout | undefined
	private deps: SchedulerDeps
	/** Läuft gerade ein Tick? Überlappende Ticks würden Pläne doppelt zünden. */
	private inFlight = false

	constructor(deps: SchedulerDeps) {
		this.deps = deps
	}

	/**
	 * Ein Tick: fällige Pläne beanspruchen und starten. Synchron — der
	 * Timer-Callback darf keine offenen Promises zurücklassen, und die
	 * Engine-Akzeptanz (`start`) ist sowieso synchron.
	 */
	tick(nowIso: string = new Date().toISOString()): void {
		if (this.inFlight) {
			return
		}
		this.inFlight = true
		try {
			const count = claimDueSchedules(this.deps.db, nowIso, (s) => runScheduleNow(this.deps, s))
			if (count > 0) {
				this.deps.log("info", "schedules", `${count} Plan/Pläne fällig — Task(s) erzeugt`)
			}
		} finally {
			this.inFlight = false
		}
	}

	/** Timer starten (Default 30 s). `unref` hält den Prozess nie offen. */
	start(intervalMs = 30_000): void {
		if (this.timer) {
			return
		}
		this.timer = setInterval(() => this.tick(), intervalMs)
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
