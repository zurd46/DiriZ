/**
 * Log-Routen: persistierte Logs (SQLite) + In-Memory-Buffer als Fallback.
 */

import type { LogLevel } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { listLogRows } from "../db/repositories.js"
import { listLogs } from "../logger.js"

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"]

export function registerLogs(app: FastifyInstance, ctx: AppContext): void {
	app.get<{ Querystring: { level?: string; scope?: string; limit?: string } }>("/api/logs", (req, reply) => {
		const level = req.query.level as LogLevel | undefined
		if (level && !LEVELS.includes(level)) {
			return reply.code(400).send({ error: `level muss einer von ${LEVELS.join(", ")} sein` })
		}
		const limit = req.query.limit ? Number(req.query.limit) : undefined
		const dbRows = listLogRows(ctx.db, { level, scope: req.query.scope, limit })
		if (dbRows.length > 0) {
			return dbRows
		}
		return listLogs({ level, scope: req.query.scope, limit })
	})
}
