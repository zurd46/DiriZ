/**
 * Workspace-Routen (`01-plan.md` §9): Dateibaum + Dateiinhalte (Sandbox
 * `~/DiriZ/workspace`). Alle Pfade stammen aus der DB — kein Freiform-Nutzerinput.
 */

import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import { getFileContent, listFileHistory, workspaceFiles } from "../db/repositories.js"

export function registerWorkspace(app: FastifyInstance, ctx: AppContext): void {
	app.get("/api/workspace", () => {
		return { dir: ctx.workspaceDir, files: workspaceFiles(ctx.db) }
	})

	app.get<{ Querystring: { path?: string } }>("/api/workspace/file-history", (req, reply) => {
		const relPath = req.query.path
		if (!relPath) {
			return reply.code(400).send({ error: "path ist erforderlich" })
		}
		return listFileHistory(ctx.db, relPath)
	})

	app.get<{ Querystring: { executionId?: string; path?: string } }>("/api/workspace/file", (req, reply) => {
		const { executionId, path: relPath } = req.query
		if (!executionId || !relPath) {
			return reply.code(400).send({ error: "executionId und path sind erforderlich" })
		}
		const content = getFileContent(ctx.db, executionId, relPath)
		if (content === undefined) {
			return reply.code(404).send({ error: "Datei nicht gefunden" })
		}
		return { relPath, content }
	})
}
