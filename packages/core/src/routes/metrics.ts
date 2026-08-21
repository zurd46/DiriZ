/**
 * Metrik-Routen (`01-plan.md` §8.2): Summary + stündliche Zeitreihe.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { metricsSummary, timeseries } from "../db/repositories.js"

export function registerMetrics(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/metrics", () => {
		const summary = metricsSummary(ctx.db, ctx.engine.activeCount)
		return { ...summary, activeExecutions: ctx.engine.activeCount }
	})

	app.get<{ Querystring: { hours?: string } }>("/api/metrics/timeseries", (req, reply) => {
		const hours = req.query.hours ? Number(req.query.hours) : 24
		if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
			return reply.code(400).send({ error: "hours muss 1–720 sein" })
		}
		return timeseries(ctx.db, hours)
	})
}
