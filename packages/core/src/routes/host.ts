/**
 * Host-Metriken-Route (M8): `GET /api/host/metrics` — RAM/CPU/GPU des
 * Rechners. Nutzt der Dashboard-System-Karte und die Routing-Achse hostLoad.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { getHostMetrics } from "../monitoring/host.js"

export function registerHost(app: FastifyInstance, _ctx: AppContext): void {
	app.get("/api/host/metrics", async (_req, reply) => {
		try {
			return await getHostMetrics()
		} catch (e) {
			return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
		}
	})
}
