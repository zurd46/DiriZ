/**
 * T1-4 Scheduling-Routen: CRUD für Zeitpläne + „jetzt starten".
 *
 * Drei Planarten:
 *   • einmalig   → `once: true` + `nextRunAt` (ISO-Zeitstempel in der Zukunft)
 *   • Intervall  → `everyMinutes: n`
 *   • Cron       → `cron: "m h dom mon dow"` (5 Felder, lokale Zeit)
 */
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { getAgent } from "../db/repositories.js"
import { log } from "../logger.js"
import {
	claimDueSchedules,
	createSchedule,
	deleteSchedule,
	getSchedule,
	listSchedules,
	nextCronRun,
	runScheduleNow,
	updateSchedule,
} from "../scheduling/scheduler.js"

interface ScheduleBody {
	title?: string
	prompt?: string
	agentId?: string | null
	privacy?: "local-only" | "allow-cloud"
	pinnedProviderId?: string | null
	pinnedModelId?: string | null
	cron?: string | null
	everyMinutes?: number | null
	once?: boolean
	nextRunAt?: string | null
	enabled?: boolean
}

/**
 * Prüft die Zeitangabe: genau eine Planart, und wenn Cron, dann ein
 * gültiges 5-Felder-Cron. Gibt eine Fehlermeldung oder `undefined` zurück.
 */
function validateTiming(body: ScheduleBody): string | undefined {
	const hasCron = typeof body.cron === "string" && body.cron.trim().length > 0
	const hasInterval =
		typeof body.everyMinutes === "number" && Number.isInteger(body.everyMinutes) && body.everyMinutes >= 1
	const hasOnce = body.once === true && typeof body.nextRunAt === "string"
	const count = [hasCron, hasInterval, hasOnce].filter(Boolean).length
	if (count === 0) {
		return "Zeitplan fehlt: einmalig (nextRunAt), Intervall (everyMinutes) oder Cron wählen"
	}
	if (count > 1) {
		return "genau eine Planart wählen: einmalig, Intervall oder Cron"
	}
	if (hasCron && !nextCronRun(body.cron as string, new Date())) {
		return `ungültiges Cron „${body.cron}“ — erwartet werden 5 Felder (Minute, Stunde, Tag, Monat, Wochentag)`
	}
	if (hasInterval && (body.everyMinutes as number) < 1) {
		return "Intervall muss mindestens 1 Minute sein"
	}
	if (hasOnce && Number.isNaN(Date.parse(body.nextRunAt as string))) {
		return "ungültiger Zeitstempel für den einmaligen Lauf"
	}
	return undefined
}

function timingError(db: AppContext["db"], body: ScheduleBody): string | undefined {
	const err = validateTiming(body)
	if (err) {
		return err
	}
	// Agent muss existieren, wenn einer gepinnt ist.
	if (body.agentId && !getAgent(db, body.agentId)) {
		return `Agent ${body.agentId} existiert nicht`
	}
	return undefined
}

export function registerSchedules(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/schedules", () => listSchedules(ctx.db))

	app.post<{ Body: ScheduleBody }>(`/api/schedules`, (req, reply) => {
		const body = req.body ?? {}
		if (!body.title || body.title.trim().length === 0) {
			return reply.code(400).send({ error: "Titel fehlt" })
		}
		if (!body.prompt || body.prompt.trim().length === 0) {
			return reply.code(400).send({ error: "Prompt fehlt" })
		}
		const err = timingError(ctx.db, body)
		if (err) {
			return reply.code(400).send({ error: err })
		}
		const schedule = createSchedule(ctx.db, {
			title: body.title.trim(),
			prompt: body.prompt,
			agentId: body.agentId ?? undefined,
			privacy: body.privacy,
			pinnedProviderId: body.pinnedProviderId ?? undefined,
			pinnedModelId: body.pinnedModelId ?? undefined,
			cron: body.cron ?? undefined,
			everyMinutes: body.everyMinutes ?? undefined,
			once: body.once,
			nextRunAt: body.nextRunAt ?? undefined,
			enabled: body.enabled,
		})
		return reply.code(201).send(schedule)
	})

	app.patch<{ Params: { id: string }; Body: ScheduleBody }>(`/api/schedules/:id`, (req, reply) => {
		const existing = getSchedule(ctx.db, req.params.id)
		if (!existing) {
			return reply.code(404).send({ error: "Zeitplan nicht gefunden" })
		}
		const body = req.body ?? {}
		const patch: Record<string, unknown> = {}
		for (const key of [
			"title",
			"prompt",
			"agentId",
			"privacy",
			"pinnedProviderId",
			"pinnedModelId",
			"cron",
			"everyMinutes",
			"once",
			"nextRunAt",
			"enabled",
		] as const) {
			if (body[key] !== undefined) {
				patch[key] = body[key]
			}
		}
		if (Object.keys(patch).length > 0) {
			// Die geänderten Felder + Bestand zusammen prüfen.
			const merged = { ...existing, ...body }
			const err = timingError(ctx.db, merged)
			if (err) {
				return reply.code(400).send({ error: err })
			}
			const updated = updateSchedule(ctx.db, req.params.id, patch as never)
			if (!updated) {
				return reply.code(404).send({ error: "Zeitplan nicht gefunden" })
			}
			// Wenn die Planart sich geändert hat, die Fälligkeit neu berechnen.
			const recompute =
				(body.cron !== undefined ||
					body.everyMinutes !== undefined ||
					body.once !== undefined ||
					body.nextRunAt !== undefined) &&
				updated.enabled
			if (recompute) {
				let next: string | null = null
				if (updated.everyMinutes !== null) {
					next = new Date(Date.now() + updated.everyMinutes * 60_000).toISOString()
				} else if (updated.cron) {
					next = nextCronRun(updated.cron, new Date())?.toISOString() ?? null
				}
				ctx.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(next, updated.id)
			}
			return getSchedule(ctx.db, req.params.id)
		}
		return existing
	})

	app.delete<{ Params: { id: string } }>(`/api/schedules/:id`, (req, reply) => {
		if (!deleteSchedule(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Zeitplan nicht gefunden" })
		}
		return reply.code(204).send()
	})

	/**
	 * „Jetzt starten" — erzeugt sofort die Task, ohne auf die Fälligkeit zu
	 * warten. Ein einmaliger Plan, der schon abgelaufen ist, wird trotzdem
	 * gestartet; seine Fälligkeit wird danach nicht berührt.
	 */
	app.post<{ Params: { id: string } }>(`/api/schedules/:id/run-now`, (req, reply) => {
		const schedule = getSchedule(ctx.db, req.params.id)
		if (!schedule) {
			return reply.code(404).send({ error: "Zeitplan nicht gefunden" })
		}
		const deps = {
			db: ctx.db,
			engine: ctx.engine,
			emit: ctx.bus.emit.bind(ctx.bus),
			log: (level: "info" | "warn" | "error", scope: string, msg: string) => log(level, scope, msg),
		}
		const taskId = runScheduleNow(deps, schedule)
		if (!taskId) {
			return reply.code(409).send({ error: "Start abgelehnt — Parallelitäts-Limit oder Task läuft bereits" })
		}
		return reply.code(202).send({ accepted: true, taskId })
	})

	/**
	 * Test-/Debug-Helfer: einen Tick sofort ausführen — in der Praxis tickt
	 * der Scheduler alle 30 s; hier kann man ihn manuell triggern.
	 */
	app.post("/api/schedules/tick", () => {
		const deps = {
			db: ctx.db,
			engine: ctx.engine,
			emit: ctx.bus.emit.bind(ctx.bus),
			log: (level: "info" | "warn" | "error", scope: string, msg: string) => log(level, scope, msg),
		}
		const now = new Date().toISOString()
		const fired = claimDueSchedules(ctx.db, now, (s) => runScheduleNow(deps, s))
		return { fired }
	})
}
