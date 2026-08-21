/**
 * Health-Check (`01-plan.md` §7.2): Liveness + Schema-Version.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { getSetting } from "../db/repositories.js"

export function registerHealth(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/health", () => {
		return {
			ok: true,
			schemaVersion: getSetting<{ schemaVersion: number }>(ctx.db, "schema_version")?.schemaVersion ?? 0,
			activeExecutions: ctx.engine.activeCount,
			providers: ctx.registry.providerIds.length,
		}
	})
}
