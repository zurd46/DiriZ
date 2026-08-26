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
import { registerAgents } from "./routes/agents.js"
import { registerAuth } from "./routes/auth.js"
import { registerDocs } from "./routes/docs.js"
import { registerHealth } from "./routes/health.js"
import { registerHost } from "./routes/host.js"
import { registerInstances } from "./routes/instances.js"
import { registerLogs } from "./routes/logs.js"
import { registerMetrics } from "./routes/metrics.js"
import { registerProviders } from "./routes/providers.js"
import { registerRepos } from "./routes/repos.js"
import { registerSchedules } from "./routes/schedules.js"
import { registerSettings } from "./routes/settings.js"
import { registerStream } from "./routes/stream.js"
import { registerTasks } from "./routes/tasks.js"
import { registerTemplates } from "./routes/templates.js"
import { registerVersion } from "./routes/version.js"
import { registerWebUi } from "./routes/webui.js"
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
	/** Lokale Klone der verbundenen GitHub-Repositories (M10). */
	reposDir: string
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
	const app = fastify({ logger: false })
	// `credentials: true`, weil die Anmeldung über ein Cookie läuft: Ohne das
	// schickt der Browser es aus der Dev-UI (anderer Port) nicht mit.
	await app.register(cors, {
		origin: WEB_ORIGIN,
		methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		credentials: true,
	})

	// Zuerst: Ohne gültige Sitzung kommt keine Anfrage an eine der Routen
	// darunter — der Türsteher hängt als `preHandler` vor allem, was folgt.
	registerAuth(app, ctx)

	registerHealth(app, ctx)
	registerVersion(app, ctx)
	registerHost(app, ctx)
	registerProviders(app, ctx)
	registerAgents(app, ctx)
	registerInstances(app, ctx)
	registerDocs(app, ctx)
	registerRepos(app, ctx)
	registerTasks(app, ctx)
	registerSchedules(app, ctx)
	registerTemplates(app, ctx)
	registerLogs(app, ctx)
	registerMetrics(app, ctx)
	registerSettings(app, ctx)
	registerWorkspace(app, ctx)
	registerStream(app, ctx)

	// Zuletzt: die gebaute Oberfläche + SPA-Fallback (setzt den 404-Handler).
	await registerWebUi(app)

	return app
}
