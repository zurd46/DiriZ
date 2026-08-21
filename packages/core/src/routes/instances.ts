/**
 * Instance-Routen: Modelle pro Provider — Übersicht, manuelle Korrektur
 * (Context-Fenster, Fähigkeiten, Sprachen, Preis), Entfernen.
 */

import type { Capability } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { deleteInstance, getInstance, listInstances, updateInstance } from "../db/repositories.js"

const CAPABILITIES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]

interface InstancePatchBody {
	displayName?: string
	contextWindow?: number
	capabilities?: string[]
	languages?: string[]
	quantization?: string
	priceInPerMTok?: number
	priceOutPerMTok?: number
}

export function registerInstances(app: FastifyInstance, ctx: AppContext): void {
	app.get<{ Querystring: { providerId?: string } }>("/api/instances", (req) => {
		return listInstances(ctx.db, req.query.providerId)
	})

	app.patch<{ Params: { id: string }; Body: InstancePatchBody }>("/api/instances/:id", (req, reply) => {
		const body = req.body ?? {}
		if (body.capabilities?.some((c) => !CAPABILITIES.includes(c as Capability))) {
			return reply.code(400).send({ error: `capabilities muss aus ${CAPABILITIES.join(", ")} kommen` })
		}
		const instance = updateInstance(ctx.db, req.params.id, {
			displayName: body.displayName,
			contextWindow: body.contextWindow,
			capabilities: body.capabilities as Capability[] | undefined,
			languages: body.languages,
			quantization: body.quantization,
			priceInPerMTok: body.priceInPerMTok,
			priceOutPerMTok: body.priceOutPerMTok,
		})
		if (!instance) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		return instance
	})

	app.delete<{ Params: { id: string } }>("/api/instances/:id", (req, reply) => {
		const instance = getInstance(ctx.db, req.params.id)
		if (!instance) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		if (!deleteInstance(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Instance nicht gefunden" })
		}
		return reply.code(204).send()
	})
}
