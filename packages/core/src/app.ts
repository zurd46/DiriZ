/**
 * Fastify-App (`01-plan.md` §7): CORS nur für die lokale Vite-UI,
 * Health-Check, alle API-Routen + SSE-Stream.
 */

import { WEB_ORIGIN } from "@diriz/shared"
import cors from "@fastify/cors"
import fastify, { type FastifyInstance } from "fastify"
import type { Db } from "./db/connection.js"
import type { EventBus } from "./execution/bus.js"
import type { ExecutionEngine } from "./execution/engine.js"
import type { ProviderRegistry } from "./providers/registry.js"
import { registerHealth } from "./routes/health.js"
import { registerInstances } from "./routes/instances.js"
import { registerLogs } from "./routes/logs.js"
import { registerMetrics } from "./routes/metrics.js"
import { registerProviders } from "./routes/providers.js"
import { registerStream } from "./routes/stream.js"
import { registerTasks } from "./routes/tasks.js"
import { registerWorkspace } from "./routes/workspace.js"
import type { Feedback } from "./routing/feedback.js"

/** Alles, was die Routen brauchen — einmal aufgebaut, überall injiziert. */
export interface AppContext {
	db: Db
	bus: EventBus
	registry: ProviderRegistry
	engine: ExecutionEngine
	feedback: Feedback
	secret: Buffer
	workspaceDir: string
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
	const app = fastify({ logger: false })
	await app.register(cors, { origin: WEB_ORIGIN, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] })

	registerHealth(app, ctx)
	registerProviders(app, ctx)
	registerInstances(app, ctx)
	registerTasks(app, ctx)
	registerLogs(app, ctx)
	registerMetrics(app, ctx)
	registerWorkspace(app, ctx)
	registerStream(app, ctx)

	return app
}
