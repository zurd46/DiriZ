/**
 * Task-Routen (`01-plan.md` §7.2): CRUD, Start (202), Cancel, Executions,
 * Routing-Entscheidungen, Dateien, Bewertungen.
 */

import type { TaskMetadata, TaskStatus } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createTask,
	getExecution,
	getTask,
	latestDecision,
	listExecutionsByTask,
	listFilesByTask,
	listTasks,
	replayOutput,
	updateExecution,
} from "../db/repositories.js"

interface CreateBody {
	title?: string
	prompt: string
	metadata?: Partial<TaskMetadata>
}

export function registerTasks(app: FastifyInstance, ctx: AppContext): void {
	app.get<{ Querystring: { status?: string; limit?: string } }>("/api/tasks", (req, reply) => {
		const status = req.query.status as TaskStatus | undefined
		const limit = req.query.limit ? Number(req.query.limit) : undefined
		if (
			status &&
			!["draft", "routing", "queued", "running", "done", "failed", "cancelled"].includes(status)
		) {
			return reply.code(400).send({ error: "Unbekannter Status" })
		}
		return listTasks(ctx.db, { status, limit })
	})

	app.post<{ Body: CreateBody }>("/api/tasks", (req, reply) => {
		const { title, prompt, metadata } = req.body ?? {}
		if (!prompt || prompt.trim().length === 0) {
			return reply.code(400).send({ error: "prompt fehlt" })
		}
		const task = createTask(ctx.db, { title, prompt, metadata })
		ctx.bus.emit({ event: "task.created", data: { taskId: task.id } })
		return reply.code(201).send(task)
	})

	app.get<{ Params: { id: string } }>("/api/tasks/:id", (req, reply) => {
		const task = getTask(ctx.db, req.params.id)
		if (!task) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		const executions = listExecutionsByTask(ctx.db, task.id)
		return {
			...task,
			executions,
			files: listFilesByTask(ctx.db, task.id),
			decisions: executions.map((e) => latestDecision(ctx.db, e.id)).filter((d) => d !== undefined),
			running: ctx.engine.isRunning(task.id),
		}
	})

	app.patch<{ Params: { id: string }; Body: { title?: string; prompt?: string } }>(
		"/api/tasks/:id",
		(req, reply) => {
			const task = getTask(ctx.db, req.params.id)
			if (!task) {
				return reply.code(404).send({ error: "Task nicht gefunden" })
			}
			if (ctx.engine.isRunning(task.id)) {
				return reply.code(409).send({ error: "Task läuft — kann nicht bearbeitet werden" })
			}
			const { title, prompt } = req.body ?? {}
			const newTitle = title?.trim() || task.title
			const newPrompt = prompt?.trim() || task.prompt
			ctx.db.prepare("UPDATE tasks SET title = ?, prompt = ? WHERE id = ?").run(newTitle, newPrompt, task.id)
			return getTask(ctx.db, task.id)
		},
	)

	app.delete<{ Params: { id: string } }>("/api/tasks/:id", (req, reply) => {
		const task = getTask(ctx.db, req.params.id)
		if (!task) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		if (ctx.engine.isRunning(task.id)) {
			return reply.code(409).send({ error: "Task läuft — bitte erst abbrechen" })
		}
		ctx.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
		return reply.code(204).send()
	})

	app.post<{ Params: { id: string } }>("/api/tasks/:id/start", (req, reply) => {
		const task = getTask(ctx.db, req.params.id)
		if (!task) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		const result = ctx.engine.start(task.id)
		if (!result.accepted) {
			return reply.code(409).send({ error: result.reason })
		}
		return reply.code(202).send({ accepted: true, taskId: task.id })
	})

	app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", (req, reply) => {
		if (!ctx.engine.cancelTask(req.params.id)) {
			return reply.code(409).send({ error: "Keine aktive Execution für diese Task" })
		}
		return { cancelled: true }
	})

	app.get<{ Params: { id: string } }>("/api/tasks/:id/replay", (req, reply) => {
		const executions = listExecutionsByTask(ctx.db, req.params.id)
		if (executions.length === 0) {
			return reply.code(404).send({ error: "Keine Executions" })
		}
		const last = executions[executions.length - 1]
		return { executionId: last.id, output: last.output ?? replayOutput(ctx.db, last.id) }
	})

	app.post<{ Params: { id: string }; Body: { rating?: number; comment?: string } }>(
		"/api/executions/:id/rating",
		(req, reply) => {
			const execution = getExecution(ctx.db, req.params.id)
			if (!execution) {
				return reply.code(404).send({ error: "Execution nicht gefunden" })
			}
			const { rating, comment } = req.body ?? {}
			if (rating !== undefined && (rating < 1 || rating > 5)) {
				return reply.code(400).send({ error: "rating muss 1–5 sein" })
			}
			updateExecution(ctx.db, execution.id, {
				rating: rating ?? undefined,
				ratingComment: comment ?? undefined,
			})
			if (rating !== undefined) {
				ctx.feedback.record(execution.instanceId ?? "", execution.status === "done", rating)
			}
			return getExecution(ctx.db, execution.id)
		},
	)
}
