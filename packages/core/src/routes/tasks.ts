/**
 * Task-Routen (`01-plan.md` §7.2): CRUD, Start (202), Cancel, Executions,
 * Routing-Entscheidungen, Dateien, Bewertungen.
 */

import type { ModelSettings, TaskMetadata, TaskStatus } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import type { Db } from "../db/connection.js"
import {
	createTask,
	deleteChat,
	getAgent,
	getExecution,
	getInstance,
	getProvider,
	getRepo,
	getSwarm,
	getTask,
	latestAgentSelection,
	latestDecision,
	listChatTasks,
	listCompareTasks,
	listExecutionsByTask,
	listFilesByTask,
	listRecentCompares,
	listTasks,
	listToolCallsByTask,
	replayOutput,
	setTaskRepo,
	updateExecution,
} from "../db/repositories.js"

interface CreateBody {
	title?: string
	prompt: string
	metadata?: Partial<TaskMetadata>
	assignmentMode?: "auto" | "agent" | "swarm"
	agentId?: string
	swarmId?: string
	overrides?: ModelSettings
}

type AssignmentModeValue = "auto" | "agent" | "swarm"

/** Prüft die Zuweisung konsistent (Create, Patch, Start). */
function validateAssignment(
	db: Db,
	assignmentMode: AssignmentModeValue | undefined,
	agentId?: string,
	swarmId?: string,
): string | undefined {
	const mode = assignmentMode ?? "auto"
	if (!["auto", "agent", "swarm"].includes(mode)) {
		return "assignmentMode muss auto, agent oder swarm sein"
	}
	if (mode === "agent") {
		if (!agentId) {
			return 'Zuweisungsmodus "agent" benötigt einen agentId'
		}
		const agent = getAgent(db, agentId)
		if (!agent) {
			return `Agent ${agentId} existiert nicht`
		}
		if (!agent.enabled) {
			return `Agent ${agent.name} ist deaktiviert`
		}
	}
	if (mode === "swarm") {
		if (!swarmId) {
			return 'Zuweisungsmodus "swarm" benötigt einen swarmId'
		}
		const swarm = getSwarm(db, swarmId)
		if (!swarm) {
			return `Swarm ${swarmId} existiert nicht`
		}
		if (!swarm.enabled) {
			return `Swarm ${swarm.name} ist deaktiviert`
		}
	}
	return undefined
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
		const { title, prompt, metadata, assignmentMode, agentId, swarmId, overrides } = req.body ?? {}
		if (!prompt || prompt.trim().length === 0) {
			return reply.code(400).send({ error: "prompt fehlt" })
		}
		const assignmentErr = validateAssignment(ctx.db, assignmentMode, agentId, swarmId)
		if (assignmentErr) {
			return reply.code(400).send({ error: assignmentErr })
		}
		const task = createTask(ctx.db, { title, prompt, metadata, assignmentMode, agentId, swarmId, overrides })
		ctx.bus.emit({ event: "task.created", data: { taskId: task.id } })
		return reply.code(201).send(task)
	})

	/* ---------------------------------- Chats ---------------------------------- */

	/**
	 * Der Chat-Verlauf, nach Gesprächen gruppiert.
	 *
	 * Der Verlauf **ist** die Datenbank: Jede Chat-Nachricht ist eine Task, die
	 * `chatId` in ihren Metadaten fasst sie zu einem Gespräch zusammen. Damit
	 * überlebt der Verlauf Neuladen, Browserwechsel und Neustart — und bleibt
	 * unter „Tasks“ mit Routing-Entscheidung nachvollziehbar.
	 */
	app.get<{ Querystring: { chatId?: string; limit?: string } }>("/api/chats", (req) => {
		const tasks = listChatTasks(ctx.db, req.query.chatId)
		const chats = new Map<
			string,
			{
				chatId: string
				title: string
				createdAt: string
				updatedAt: string
				turns: unknown[]
			}
		>()

		for (const task of tasks) {
			const chatId = task.metadata.chatId
			if (!chatId) {
				continue
			}
			const executions = listExecutionsByTask(ctx.db, task.id)
			const last = executions.at(-1)
			const selection = latestAgentSelection(ctx.db, task.id)
			const instance = last?.instanceId ? getInstance(ctx.db, last.instanceId) : undefined
			const provider = instance ? getProvider(ctx.db, instance.providerId) : undefined
			const turn = {
				taskId: task.id,
				prompt: task.prompt,
				title: task.title,
				status: task.status,
				createdAt: task.createdAt,
				agentMode: task.metadata.agentMode === true,
				// Kettenschritt: Die Oberfläche zeigt eine Übergabe anders an als
				// eine getippte Nachricht — sie stammt vom vorigen Spezialisten.
				chain: task.metadata.chain
					? {
							// Stufen, nicht Einzelschritte: Innerhalb einer Stufe arbeiten
							// mehrere Spezialisten gleichzeitig.
							step: (task.metadata.chain.stage ?? task.metadata.chain.index) + 1,
							total: task.metadata.chain.stages?.length ?? task.metadata.chain.agentIds.length,
						}
					: null,
				repoId: task.repoId ?? null,
				// A/B-Vergleich: bindet die Spalten eines Duells zusammen (T1-1).
				compareId: task.metadata.compareId ?? null,
				// Welches Projekt, welcher Branch — „GitHub“ allein sagt nichts.
				repoFullName: task.repoId ? (getRepo(ctx.db, task.repoId)?.fullName ?? null) : null,
				workBranch: task.workBranch ?? null,
				pushedAt: task.pushedAt ?? null,
				prUrl: task.prUrl ?? null,
				agentName: selection?.agentName ?? null,
				agentReason: selection?.reason ?? null,
				modelName: instance?.displayName ?? null,
				providerLabel: provider?.label ?? null,
				answer: last?.output ?? "",
				error: last?.error ?? null,
				files: listFilesByTask(ctx.db, task.id).map((f) => ({ relPath: f.relPath, size: f.size })),
				toolCalls: listToolCallsByTask(ctx.db, task.id).map((t) => ({
					id: `${t.executionId}-${t.seq}`,
					name: t.name,
					argsSummary: t.argsSummary,
					ok: t.ok,
				})),
			}
			const entry = chats.get(chatId)
			if (entry) {
				entry.turns.push(turn)
				entry.updatedAt = task.createdAt
			} else {
				chats.set(chatId, {
					chatId,
					// Der erste Satz benennt das Gespräch — wie in jedem Chat-Programm.
					title: task.title?.trim() || task.prompt.split(/\r?\n/)[0]?.slice(0, 70) || "Chat",
					createdAt: task.createdAt,
					updatedAt: task.createdAt,
					turns: [turn],
				})
			}
		}

		// Neueste Gespräche zuerst — der Verlauf innerhalb eines Gesprächs bleibt
		// chronologisch, sonst läse sich die Unterhaltung rückwärts.
		return [...chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	})

	/**
	 * Ein Gespräch samt allen Nachrichten löschen. Läuft noch etwas, wird
	 * abgelehnt statt heimlich abgebrochen — sonst verschwände eine Task, deren
	 * Modell gerade Dateien schreibt.
	 */
	app.delete<{ Params: { chatId: string } }>("/api/chats/:chatId", (req, reply) => {
		const tasks = listChatTasks(ctx.db, req.params.chatId)
		if (tasks.length === 0) {
			return reply.code(404).send({ error: "Gespräch nicht gefunden" })
		}
		const laufend = tasks.find((t) => ctx.engine.isRunning(t.id))
		if (laufend) {
			return reply.code(409).send({ error: "Im Gespräch läuft noch eine Aufgabe — bitte erst abbrechen" })
		}
		const deleted = deleteChat(ctx.db, req.params.chatId)
		return { deleted }
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
			toolCalls: listToolCallsByTask(ctx.db, task.id),
			files: listFilesByTask(ctx.db, task.id),
			decisions: executions.map((e) => latestDecision(ctx.db, e.id)).filter((d) => d !== undefined),
			agentSelection: latestAgentSelection(ctx.db, task.id),
			agent: task.agentId ? getAgent(ctx.db, task.agentId) : undefined,
			running: ctx.engine.isRunning(task.id),
		}
	})

	interface PatchBody {
		title?: string
		prompt?: string
		assignmentMode?: AssignmentModeValue
		/** "null" = Agent/Swarm zurücksetzen. */
		agentId?: string | null
		swarmId?: string | null
		/** "null" = Overrides zurücksetzen. */
		overrides?: ModelSettings | null
	}

	app.patch<{ Params: { id: string }; Body: PatchBody }>("/api/tasks/:id", (req, reply) => {
		const task = getTask(ctx.db, req.params.id)
		if (!task) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		if (ctx.engine.isRunning(task.id)) {
			return reply.code(409).send({ error: "Task läuft — kann nicht bearbeitet werden" })
		}
		const body = req.body ?? {}
		const merged = {
			assignmentMode: body.assignmentMode ?? task.assignmentMode ?? "auto",
			agentId: body.agentId === null ? undefined : (body.agentId ?? task.agentId),
			swarmId: body.swarmId === null ? undefined : (body.swarmId ?? task.swarmId),
		}
		const assignmentErr = validateAssignment(ctx.db, merged.assignmentMode, merged.agentId, merged.swarmId)
		if (assignmentErr) {
			return reply.code(400).send({ error: assignmentErr })
		}
		const newTitle = body.title?.trim() || task.title
		const newPrompt = body.prompt?.trim() || task.prompt
		ctx.db
			.prepare(
				"UPDATE tasks SET title = ?, prompt = ?, assignment_mode = ?, agent_id = ?, swarm_id = ?, overrides_json = ? WHERE id = ?",
			)
			.run(
				newTitle,
				newPrompt,
				merged.assignmentMode,
				merged.agentId ?? null,
				merged.swarmId ?? null,
				body.overrides === null
					? null
					: body.overrides
						? JSON.stringify(body.overrides)
						: task.overrides
							? JSON.stringify(task.overrides)
							: null,
				task.id,
			)
		return getTask(ctx.db, task.id)
	})

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
		if (ctx.engine.isRunning(task.id)) {
			return reply.code(409).send({ error: "Task läuft bereits" })
		}
		const assignmentErr = validateAssignment(
			ctx.db,
			task.assignmentMode ?? "auto",
			task.agentId,
			task.swarmId,
		)
		if (assignmentErr) {
			return reply.code(400).send({ error: assignmentErr })
		}
		const result = ctx.engine.start(task.id)
		if (!result.accepted) {
			return reply.code(409).send({ error: result.reason })
		}
		return reply.code(202).send({ accepted: true, taskId: task.id })
	})

	/**
	 * Einen abgebrochenen oder steckengebliebenen Lauf **fortsetzen**.
	 *
	 * Der Arbeitsstand ist nicht verloren: Die gelesenen Dateien, die
	 * geschriebenen Änderungen und die halbe Antwort liegen vor. Bisher stand
	 * im Fehlertext „Task mit dem bisherigen Stand erneut starten" — ohne dass
	 * es dafür einen Weg gab. Hier ist er: eine neue Task mit demselben
	 * Spezialisten, demselben Arbeitsverzeichnis und dem bisherigen Stand als
	 * Vorarbeit.
	 */
	app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", (req, reply) => {
		const task = getTask(ctx.db, req.params.id)
		if (!task) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		if (ctx.engine.isRunning(task.id)) {
			return reply.code(409).send({ error: "Task läuft noch — erst abbrechen" })
		}
		const letzte = listExecutionsByTask(ctx.db, task.id).at(-1)
		const stand = (letzte?.output ?? "").trim()
		const werkzeuge = listToolCallsByTask(ctx.db, task.id)
			.filter((c) => c.ok)
			.map((c) => `- ${c.name}(${c.argsSummary})`)

		const folge = createTask(ctx.db, {
			title: task.title,
			prompt: [
				"## Ursprünglicher Auftrag",
				"",
				task.prompt.trim(),
				"",
				"## Bisheriger Stand",
				"",
				stand || "_(keine Textantwort — der Lauf endete vorzeitig)_",
				...(werkzeuge.length > 0
					? ["", "## Bereits erledigt", "", "Im **selben** Arbeitsverzeichnis:", "", ...werkzeuge]
					: []),
				"",
				"## Deine Aufgabe",
				"",
				"Setze genau hier fort. Wiederhole nichts davon, sondern bringe den Auftrag zu Ende.",
			].join("\n"),
			metadata: {
				...task.metadata,
				// Dasselbe Arbeitsverzeichnis wie der abgebrochene Lauf: Seine
				// Dateien und Änderungen liegen dort bereits.
				chain: {
					agentIds: [task.agentId ?? ""],
					index: 0,
					stages: [[task.agentId ?? ""]],
					stage: 0,
					goal: task.metadata.chain?.goal ?? task.prompt,
					id: task.metadata.chain?.id ?? task.id,
					rootTaskId: task.metadata.chain?.rootTaskId ?? task.id,
				},
			},
			assignmentMode: task.agentId ? "agent" : "auto",
			agentId: task.agentId ?? undefined,
			repoId: task.repoId ?? null,
			baseBranch: task.baseBranch ?? null,
		})
		if (task.repoId && task.workBranch) {
			setTaskRepo(ctx.db, folge.id, { workBranch: task.workBranch })
		}
		const started = ctx.engine.start(folge.id)
		return reply.code(202).send({ taskId: folge.id, started: started.accepted, reason: started.reason })
	})

	app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", (req, reply) => {
		if (!ctx.engine.cancelTask(req.params.id)) {
			return reply.code(409).send({ error: "Keine aktive Execution für diese Task" })
		}
		return { cancelled: true }
	})

	app.post<{ Params: { id: string } }>(`/api/tasks/:id/preview`, async (req, reply) => {
		const preview = await ctx.engine.preview(req.params.id)
		if (!preview) {
			return reply.code(404).send({ error: "Task nicht gefunden" })
		}
		return preview
	})

	/* ----------------------- A/B-Vergleich (T1-1, Modell-Duell) ----------------------- */

	/**
	 * Gleicher Auftrag, mehrere Modelle parallel — jedes Mitglied ist eine
	 * normale Task auf ihrer Pinned-Instanz, verbunden durch `compareId`.
	 * So bleibt alles nachvollziehbar: Jede Spalte hat Routing-Entscheid,
	 * Dateien und Bewertung wie jeder andere Lauf.
	 */
	app.post<{ Body: { prompt: string; title?: string; instanceIds: string[]; chatId?: string } }>(
		`/api/compare`,
		(req, reply) => {
			const { prompt, title, instanceIds, chatId } = req.body ?? {}
			if (!prompt || prompt.trim().length === 0) {
				return reply.code(400).send({ error: "prompt fehlt" })
			}
			if (!Array.isArray(instanceIds) || instanceIds.length < 2) {
				return reply.code(400).send({ error: "mindestens 2 Instanzen wählen" })
			}
			if (instanceIds.length > 4) {
				return reply.code(400).send({ error: "maximal 4 Modelle pro Vergleich" })
			}
			const unique = [...new Set(instanceIds)]
			if (unique.length < 2) {
				return reply.code(400).send({ error: "Instanzen müssen unterschiedlich sein" })
			}
			const compareId = crypto.randomUUID()
			// `chatId` bindet das Duell an ein Gespräch (optional) — beide Kennungen
			// koexistieren: `compareId` fasst die Spalten, `chatId` den Verlauf.
			const baseMeta: Partial<TaskMetadata> = { privacy: "local-only", mode: "pinned", compareId }
			if (chatId) {
				baseMeta.chatId = chatId
			}
			const tasks: { taskId: string; instanceId: string; started: boolean; reason?: string }[] = []
			for (const instanceId of unique) {
				const inst = getInstance(ctx.db, instanceId)
				if (!inst) {
					return reply.code(400).send({ error: `Instanz ${instanceId} existiert nicht` })
				}
				const task = createTask(ctx.db, {
					title: (title ?? "").trim()
						? `${(title ?? "").trim()} · ${inst.displayName}`
						: `Vergleich · ${inst.displayName}`,
					prompt: prompt.trim(),
					metadata: { ...baseMeta, preferredProviderId: inst.providerId, preferredModelId: inst.modelId },
				})
				ctx.bus.emit({ event: "task.created", data: { taskId: task.id } })
				const result = ctx.engine.start(task.id)
				tasks.push({ taskId: task.id, instanceId, started: result.accepted, reason: result.reason })
			}
			return reply.code(201).send({ compareId, tasks })
		},
	)

	app.get<{ Querystring: { limit?: string } }>(`/api/compare/recent`, (req) => {
		const limit = req.query.limit ? Number(req.query.limit) : 20
		return listRecentCompares(ctx.db, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20)
	})

	app.get<{ Params: { compareId: string } }>(`/api/compare/:compareId`, (req, reply) => {
		const members = listCompareTasks(ctx.db, req.params.compareId)
		if (members.length === 0) {
			return reply.code(404).send({ error: "Vergleich nicht gefunden" })
		}
		const finished = new Set(["done", "failed", "cancelled"])
		const view = members.map((task) => {
			const executions = listExecutionsByTask(ctx.db, task.id)
			const last = executions.at(-1)
			const inst = last?.instanceId ? getInstance(ctx.db, last.instanceId) : undefined
			const provider = inst ? getProvider(ctx.db, inst.providerId) : undefined
			const started = last?.startedAt ? Date.parse(last.startedAt) : undefined
			const end = last?.finishedAt ? Date.parse(last.finishedAt) : undefined
			return {
				taskId: task.id,
				instanceId: last?.instanceId,
				providerId: last?.providerId,
				modelName: inst?.displayName ?? "—",
				providerLabel: provider?.label ?? null,
				status: task.status,
				output: last?.output ?? "",
				error: last?.error ?? null,
				tokensIn: last?.tokensIn,
				tokensOut: last?.tokensOut,
				tpsAvg: last?.tpsAvg,
				costUsd: last?.costUsd,
				durationMs: started !== undefined && end !== undefined ? end - started : undefined,
			}
		})
		return {
			compareId: req.params.compareId,
			prompt: members[0].prompt,
			createdAt: members[0].createdAt,
			members: view,
			allFinished: members.every((t) => finished.has(t.status)),
		}
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
