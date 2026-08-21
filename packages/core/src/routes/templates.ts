/**
 * Prompt-Template-Routen (M2/Q4): CRUD für wiederverwendbare
 * System-Prompt-Vorlagen, die den Task-Override `systemPrompt` füllen.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	updateTemplate,
} from "../db/repositories.js"

interface TemplateBody {
	name?: string
	prompt?: string
}

export function registerTemplates(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/templates", () => listTemplates(ctx.db))

	app.post<{ Body: TemplateBody }>("/api/templates", (req, reply) => {
		const { name, prompt } = req.body ?? {}
		if (!name || name.trim().length === 0) {
			return reply.code(400).send({ error: "Name fehlt" })
		}
		if (!prompt || prompt.trim().length === 0) {
			return reply.code(400).send({ error: "Prompt fehlt" })
		}
		try {
			const tpl = createTemplate(ctx.db, { name: name.trim(), prompt })
			return reply.code(201).send(tpl)
		} catch (e) {
			if (String(e).includes("UNIQUE")) {
				return reply.code(409).send({ error: `Vorlage „${name.trim()}“ existiert bereits` })
			}
			throw e
		}
	})

	app.patch<{ Params: { id: string }; Body: TemplateBody }>("/api/templates/:id", (req, reply) => {
		const existing = getTemplate(ctx.db, req.params.id)
		if (!existing) {
			return reply.code(404).send({ error: "Vorlage nicht gefunden" })
		}
		const { name, prompt } = req.body ?? {}
		try {
			const updated = updateTemplate(ctx.db, existing.id, { name, prompt })
			if (!updated) {
				return reply.code(404).send({ error: "Vorlage nicht gefunden" })
			}
			return updated
		} catch (e) {
			if (String(e).includes("UNIQUE")) {
				return reply.code(409).send({ error: `Name „${name?.trim()}“ ist bereits vergeben` })
			}
			throw e
		}
	})

	app.delete<{ Params: { id: string } }>("/api/templates/:id", (req, reply) => {
		if (!deleteTemplate(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Vorlage nicht gefunden" })
		}
		return reply.code(204).send()
	})
}
