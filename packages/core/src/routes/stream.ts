/**
 * SSE-Stream (`01-plan.md` §7.3): `GET /api/stream`.
 *
 * - `text/event-stream`, Keep-Alive-Comment alle 15 s
 * - Jeder Bus-Event wird als `event: <name>\ndata: <json>` serialisiert.
 * - Beim Client-Disconnect wird der Listener entfernt.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"

export function registerStream(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/stream", (req, reply) => {
		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		})
		reply.raw.write(": DiriZ Stream eröffnet\n\n")

		const unsubscribe = ctx.bus.subscribe((event) => {
			try {
				reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
			} catch {
				// Client weg oder Stream beendet — Event verwerfen.
			}
		})

		const heartbeat = setInterval(() => {
			reply.raw.write(": ping\n\n")
		}, 15_000)

		req.raw.on("close", () => {
			clearInterval(heartbeat)
			unsubscribe()
		})
	})
}
