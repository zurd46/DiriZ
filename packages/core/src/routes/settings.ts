/**
 * Settings-, Export- & Import-Routen (`01-plan.md` §6.2, M7):
 * - Routing-Gewichte (ScoringWeights) lesen/speichern — der Engine liest sie pro Entscheidung.
 * - Export: Tasks, Agenten, Swarms, Templates + Settings als JSON-Dokument.
 * - Import: Upsert derselben Entitäten (keine Provider/Keys — bewusst ausgeschlossen).
 */

import { DEFAULT_WEIGHTS, normalizeWeights, type ScoringWeights } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createAgent,
	createSwarm,
	createTemplate,
	getSetting,
	listAgents,
	listSwarms,
	listTasks,
	listTemplates,
	setSetting,
	updateAgent,
	updateSwarm,
	updateTemplate,
} from "../db/repositories.js"

const WEIGHT_KEYS: (keyof ScoringWeights)[] = [
	"contextFit",
	"capabilityMatch",
	"qualityPrior",
	"loadScore",
	"costScore",
	"latencyScore",
]

/** M8: optionale 7. Achse — darf beim PUT fehlen (Backward-Kompatibilität). */
const OPTIONAL_WEIGHT_KEYS: (keyof ScoringWeights)[] = ["hostLoad"]

function parseWeights(body: unknown): ScoringWeights | undefined {
	if (!body || typeof body !== "object") {
		return undefined
	}
	const raw = body as Record<string, unknown>
	for (const key of WEIGHT_KEYS) {
		const v = raw[key]
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return undefined
		}
	}
	for (const key of OPTIONAL_WEIGHT_KEYS) {
		const v = raw[key]
		if (v === undefined) {
			continue
		}
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
			return undefined
		}
	}
	return normalizeWeights(raw as unknown as ScoringWeights)
}

export function registerSettings(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/settings", () => {
		const weights = getSetting<ScoringWeights>(ctx.db, "routing_weights") ?? DEFAULT_WEIGHTS
		return { routingWeights: normalizeWeights(weights) }
	})

	app.put<{ Body: { routingWeights?: ScoringWeights } }>("/api/settings", (req, reply) => {
		const parsed = parseWeights(req.body?.routingWeights)
		if (!parsed) {
			return reply.code(400).send({ error: "routingWeights muss Zahlen zwischen 0 und 1 sein" })
		}
		setSetting(ctx.db, "routing_weights", parsed)
		return { routingWeights: parsed }
	})

	app.get("/api/export", () => {
		const weights = getSetting<ScoringWeights>(ctx.db, "routing_weights") ?? DEFAULT_WEIGHTS
		return {
			format: "diriz-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			tasks: listTasks(ctx.db),
			agents: listAgents(ctx.db),
			swarms: listSwarms(ctx.db),
			templates: listTemplates(ctx.db),
			settings: { routingWeights: normalizeWeights(weights) },
		}
	})

	app.post<{ Body: Record<string, unknown> }>("/api/import", (req, reply) => {
		const body = req.body ?? {}
		if (body.format !== "diriz-export") {
			return reply.code(400).send({ error: "Ungültiges Export-Format (format muss 'diriz-export' sein)" })
		}

		let imported = 0

		const agents = Array.isArray(body.agents) ? body.agents : []
		for (const a of agents as { name?: string }[]) {
			if (!a.name) continue
			const existing = listAgents(ctx.db).find((x) => x.name === a.name)
			if (existing) {
				updateAgent(ctx.db, existing.id, a as never)
			} else {
				createAgent(ctx.db, a as never)
			}
			imported++
		}

		const swarms = Array.isArray(body.swarms) ? body.swarms : []
		for (const s of swarms as { name?: string }[]) {
			if (!s.name) continue
			const existing = listSwarms(ctx.db).find((x) => x.name === s.name)
			if (existing) {
				updateSwarm(ctx.db, existing.id, s as never)
			} else {
				createSwarm(ctx.db, s as never)
			}
			imported++
		}

		const templates = Array.isArray(body.templates) ? body.templates : []
		for (const t of templates as { name?: string; prompt?: string }[]) {
			if (!t.name || !t.prompt) continue
			const existing = listTemplates(ctx.db).find((x) => x.name === t.name)
			if (existing) {
				updateTemplate(ctx.db, existing.id, { name: t.name, prompt: t.prompt })
			} else {
				createTemplate(ctx.db, { name: t.name, prompt: t.prompt })
			}
			imported++
		}

		const weights = parseWeights(
			(body.settings as { routingWeights?: ScoringWeights } | undefined)?.routingWeights,
		)
		if (weights) {
			setSetting(ctx.db, "routing_weights", weights)
			imported++
		}

		return { imported, tasks: Array.isArray(body.tasks) ? body.tasks.length : 0 }
	})
}
