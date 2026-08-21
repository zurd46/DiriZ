/**
 * Execution-Engine (`01-plan.md` §6–§7): Routing → Streaming →
 * Chunk-/Gesamt-Timeout → Failover (max. 2 Hops) → Persistenz →
 * Workspace-Dateien.
 *
 * Alles deterministisch nachvollziehbar: Die Routing-Entscheidung (Scores,
 * Ausschlüsse, Profile, Gewichte) wird pro Execution persistiert und als
 * `routing.decided`-Event emittiert.
 */

import {
	type CandidateScore,
	type CoreEvent,
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUTS,
	DEFAULT_WEIGHTS,
	type Execution,
	MAX_FAILOVER_HOPS,
	type RoutingDecision,
	type Task,
} from "@diriz/shared"
import type { Db } from "../db/connection.js"
import {
	appendChunk,
	createExecution,
	getExecution,
	getTask,
	saveDecision,
	saveFile,
	setTaskStatus,
	updateExecution,
} from "../db/repositories.js"
import type { LogEntry } from "../logger.js"
import type { ProviderRegistry } from "../providers/registry.js"
import type { Feedback } from "../routing/feedback.js"
import type { PolicyCandidate } from "../routing/policies.js"
import { applyPolicies } from "../routing/policies.js"
import { extractProfile } from "../routing/profile.js"
import type { CandidateInfo } from "../routing/scorer.js"
import { scoreCandidate } from "../routing/scorer.js"
import { parseFileBlocks, writeWorkspaceFiles } from "./files.js"

type EmitFn = (event: CoreEvent) => void
type LogFn = (level: LogEntry["level"], scope: string, msg: string) => void

export class NoCandidateError extends Error {
	constructor() {
		super("Keine passende Instanz gefunden — siehe routing.decided / Ausschlüsse")
		this.name = "NoCandidateError"
	}
}

/** Abbruch durch den Nutzer — kein Failover, Status `cancelled`. */
export class CancelledError extends Error {
	constructor() {
		super("Abgebrochen vom Nutzer")
		this.name = "CancelledError"
	}
}

export interface EngineDeps {
	db: Db
	registry: ProviderRegistry
	feedback: Feedback
	emit: EmitFn
	log: LogFn
	workspaceDir: string
}

interface ActiveRun {
	abort: AbortController
	taskId: string
	cancelled: boolean
}

/** Konservative Basis-Qualität ohne Feedback-Historie. */
const BASIS_PRIOR = 0.6

export class ExecutionEngine {
	private active = new Map<string, ActiveRun>()
	private roundRobinCursor = new Map<string, number>()

	constructor(private deps: EngineDeps) {}

	get activeCount(): number {
		return this.active.size
	}

	get concurrencyLimit(): number {
		return DEFAULT_CONCURRENCY.global
	}

	isRunning(taskId: string): boolean {
		for (const run of this.active.values()) {
			if (run.taskId === taskId) {
				return true
			}
		}
		return false
	}

	/** Abbruch durch den Nutzer: kein Failover, Status `cancelled`. */
	cancel(executionId: string): boolean {
		const run = this.active.get(executionId)
		if (!run) {
			return false
		}
		run.cancelled = true
		run.abort.abort(new Error("Abgebrochen vom Nutzer"))
		return true
	}

	/** Alle aktiven Executions einer Task abbrechen. */
	cancelTask(taskId: string): boolean {
		let cancelled = false
		for (const run of this.active.values()) {
			if (run.taskId === taskId) {
				run.cancelled = true
				run.abort.abort(new Error("Abgebrochen vom Nutzer"))
				cancelled = true
			}
		}
		return cancelled
	}

	/**
	 * Asynchron starten (202-Akzeptanz): Routing + Ausführung laufen im
	 * Hintergrund; Fortschritt kommt über den SSE-Stream.
	 */
	start(taskId: string): { accepted: boolean; reason?: string } {
		const task = getTask(this.deps.db, taskId)
		if (!task) {
			return { accepted: false, reason: "Task nicht gefunden" }
		}
		if (this.isRunning(taskId)) {
			return { accepted: false, reason: "Task läuft bereits" }
		}
		if (this.activeCount >= this.concurrencyLimit) {
			return { accepted: false, reason: `Parallelitäts-Limit (${this.concurrencyLimit}) erreicht` }
		}
		void this.runTask(task).catch((e) => {
			// Status & Events werden in runTask gesetzt; hier nur Sicherungs-Log.
			this.deps.log("error", "engine", `Task ${taskId}: ${e instanceof Error ? e.message : String(e)}`)
		})
		return { accepted: true }
	}

	/* ------------------------------- Kandidaten ------------------------------- */

	/** Alle Instanzen aller Provider als Policy-Kandidaten. */
	private buildCandidates(): PolicyCandidate[] {
		const { registry } = this.deps
		const instances = registry.instances()
		const result: PolicyCandidate[] = []
		for (const inst of instances) {
			const type = registry.providerType(inst.providerId)
			if (!type) {
				continue
			}
			const providerStatus = registry.status(inst.providerId)
			const { p50 } = registry.latency(inst.providerId)
			const info: CandidateInfo = {
				instance: inst,
				loadFactor: registry.loadFactorOf(inst.providerId, inst.modelId),
				providerLatencyMs: p50,
				basisPrior: BASIS_PRIOR,
			}
			result.push({
				...info,
				providerType: type,
				providerOnline: providerStatus === "online" && !registry.isCircuitOpen(inst.providerId),
			})
		}
		return result
	}

	/* ----------------------------- Routing + Loop ------------------------------ */

	/**
	 * Führt eine Task aus: Routing, Streaming, Failover. Wirft
	 * `NoCandidateError`, wenn gar keine Instanz passt, oder `Error`,
	 * wenn alle Failover-Versuche fehlgeschlagen sind.
	 */
	async runTask(task: Task): Promise<Execution> {
		const { db, emit, log, feedback } = this.deps
		if (this.activeCount >= this.concurrencyLimit) {
			throw new Error(`Parallelitäts-Limit erreicht (${this.concurrencyLimit} aktive Executions)`)
		}

		setTaskStatus(db, task.id, "routing")
		const profile = extractProfile(task)
		const candidates = this.buildCandidates()
		const { weights, excluded, allowed } = applyPolicies(candidates, profile, DEFAULT_WEIGHTS)

		if (allowed.length === 0) {
			log("warn", "routing", `Keine Instanz für Task ${task.id}: ${excluded.length} ausgeschlossen`)
			setTaskStatus(db, task.id, "failed")
			throw new NoCandidateError()
		}

		const scored = allowed
			.map((c) => scoreCandidate(c, profile, weights, feedback))
			.sort((a, b) => b.score - a.score)

		const ordered = this.orderByMode(scored, allowed, profile.mode)
		const maxAttempts = Math.min(ordered.length, MAX_FAILOVER_HOPS + 1)

		let lastExecutionId: string | undefined
		let lastError = ""
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const choice = ordered[attempt]
			const choiceScore = scored.find((s) => s.instanceId === choice.instance.id)
			const execution = createExecution(db, {
				taskId: task.id,
				instanceId: choice.instance.id,
				providerId: choice.instance.providerId,
				failoverCount: attempt,
			})
			lastExecutionId = execution.id

			if (attempt === 0) {
				const decision: RoutingDecision = {
					executionId: execution.id,
					chosenInstanceId: choice.instance.id,
					candidates: scored,
					excluded,
					profile,
					weights: weights as unknown as Record<string, number>,
					createdAt: new Date().toISOString(),
				}
				saveDecision(db, decision)
				emit({ event: "routing.decided", data: { executionId: execution.id, decision } })
				log(
					"info",
					"routing",
					`Task ${task.id} → ${choice.instance.modelId} (Score ${choiceScore?.score ?? "?"})`,
				)
			} else {
				const from = ordered[attempt - 1].instance.modelId
				emit({
					event: "execution.failover",
					data: { executionId: execution.id, from, to: choice.instance.modelId, reason: lastError },
				})
				log("warn", "failover", `${from} → ${choice.instance.modelId}: ${lastError}`)
			}

			setTaskStatus(db, task.id, "running")
			try {
				return await this.streamExecution(execution, choice)
			} catch (e) {
				if (e instanceof CancelledError) {
					const now = new Date().toISOString()
					updateExecution(db, execution.id, {
						status: "cancelled",
						error: "Abgebrochen vom Nutzer",
						finishedAt: now,
					})
					setTaskStatus(db, task.id, "cancelled", now)
					emit({
						event: "execution.failed",
						data: { executionId: execution.id, taskId: task.id, error: "Abgebrochen vom Nutzer" },
					})
					log("info", "engine", `Execution ${execution.id} abgebrochen`)
					throw new Error("Abgebrochen vom Nutzer")
				}

				lastError = e instanceof Error ? e.message : String(e)
				this.deps.registry.recordFailure(choice.instance.providerId, lastError)
				feedback.record(choice.instance.id, false)
				updateExecution(db, execution.id, {
					status: "failed",
					error: lastError,
					finishedAt: new Date().toISOString(),
				})
			}
		}

		setTaskStatus(db, task.id, "failed")
		emit({
			event: "execution.failed",
			data: {
				executionId: lastExecutionId ?? "",
				taskId: task.id,
				error: `Alle ${maxAttempts} Versuche fehlgeschlagen: ${lastError}`,
			},
		})
		log("error", "engine", `Task ${task.id} endgültig fehlgeschlagen: ${lastError}`)
		throw new Error(`Alle Failover-Versuche fehlgeschlagen: ${lastError}`)
	}

	/** Modus-basierte Reihenfolge: `round-robin` rotiert, sonst Score-Top. */
	private orderByMode(scored: CandidateScore[], allowed: PolicyCandidate[], mode: string): PolicyCandidate[] {
		const byId = new Map(allowed.map((c) => [c.instance.id, c]))
		const ordered = scored
			.map((s) => byId.get(s.instanceId))
			.filter((c): c is PolicyCandidate => c !== undefined)
		if (mode !== "round-robin" || ordered.length <= 1) {
			return ordered
		}
		const provider = ordered[0].instance.providerId
		const cursor = this.roundRobinCursor.get(provider) ?? 0
		this.roundRobinCursor.set(provider, cursor + 1)
		const start = cursor % ordered.length
		return [...ordered.slice(start), ...ordered.slice(0, start)]
	}

	/* -------------------------------- Streaming -------------------------------- */

	/**
	 * Streamt die Chat-Antwort: Deltas → Chunks persistieren + SSE-Event,
	 * Usage erfassen, am Ende Workspace-Dateien schreiben und finalisieren.
	 * Wirft bei Timeout/Abbruch/Provider-Fehler.
	 */
	private async streamExecution(execution: Execution, choice: PolicyCandidate): Promise<Execution> {
		const { db, emit, log, registry, feedback, workspaceDir } = this.deps
		const adapter = registry.adapter(choice.instance.providerId)
		if (!adapter) {
			throw new Error(`Kein Adapter für Provider ${choice.instance.providerId}`)
		}
		const task = getTask(db, execution.taskId)
		if (!task) {
			throw new Error(`Task ${execution.taskId} nicht gefunden`)
		}

		updateExecution(db, execution.id, { status: "running", startedAt: new Date().toISOString() })

		const controller = new AbortController()
		this.active.set(execution.id, { abort: controller, taskId: task.id, cancelled: false })

		// Gesamt-Timeout + Chunk-Timeout (keine Aktivität → Failover).
		const totalTimer = setTimeout(
			() => controller.abort(new Error(`Gesamt-Timeout nach ${DEFAULT_TIMEOUTS.totalMs / 1000} s`)),
			DEFAULT_TIMEOUTS.totalMs,
		)
		let chunkTimer = setTimeout(
			() => controller.abort(new Error(`Kein Chunk seit ${DEFAULT_TIMEOUTS.chunkMs / 1000} s`)),
			DEFAULT_TIMEOUTS.chunkMs,
		)
		const resetChunkTimer = () => {
			clearTimeout(chunkTimer)
			chunkTimer = setTimeout(
				() => controller.abort(new Error(`Kein Chunk seit ${DEFAULT_TIMEOUTS.chunkMs / 1000} s`)),
				DEFAULT_TIMEOUTS.chunkMs,
			)
		}

		let fullText = ""
		let seq = 0
		let tokensIn = 0
		let tokensOut = 0
		const startedAt = Date.now()
		try {
			const stream = adapter.chat({
				messages: [{ role: "user", content: task.prompt }],
				model: choice.instance.modelId,
				signal: controller.signal,
			})
			for await (const chunk of stream) {
				if (controller.signal.aborted) {
					throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("aborted")
				}
				if (chunk.type === "delta") {
					resetChunkTimer()
					fullText += chunk.text
					appendChunk(db, execution.id, seq++, chunk.text)
					emit({
						event: "execution.delta",
						data: { executionId: execution.id, delta: chunk.text, tokens: tokensOut },
					})
				} else if (chunk.type === "usage") {
					tokensIn = chunk.tokensIn
					tokensOut = chunk.tokensOut
				}
			}
		} catch (e) {
			if (this.active.get(execution.id)?.cancelled) {
				throw new CancelledError()
			}
			throw e
		} finally {
			clearTimeout(totalTimer)
			clearTimeout(chunkTimer)
			this.active.delete(execution.id)
		}

		/* ------------------------- Finalisieren (Erfolg) ------------------------ */

		const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000)
		const tps = tokensOut > 0 ? Math.round((tokensOut / elapsedSec) * 100) / 100 : 0
		const costUsd = choice.instance.pricePerMTok
			? Math.round(
					((tokensIn * choice.instance.pricePerMTok.in + tokensOut * choice.instance.pricePerMTok.out) /
						1_000_000) *
						1_000_000,
				) / 1_000_000
			: 0

		// AI-Dateien aus dem Output parsen + in die Workspace-Sandbox schreiben.
		let writtenCount = 0
		try {
			const blocks = parseFileBlocks(fullText)
			if (blocks.length > 0) {
				const written = writeWorkspaceFiles(workspaceDir, taskSlug(task), blocks)
				for (const w of written) {
					const content = blocks.find((b) => b.relPath === w.relPath)?.content ?? ""
					saveFile(db, {
						executionId: execution.id,
						taskId: task.id,
						relPath: w.relPath,
						size: w.size,
						content,
					})
					writtenCount++
				}
			}
		} catch (e) {
			log("warn", "workspace", `Workspace-Schreibfehler: ${e instanceof Error ? e.message : String(e)}`)
		}

		const now = new Date().toISOString()
		updateExecution(db, execution.id, {
			status: "done",
			finishedAt: now,
			tokensIn,
			tokensOut,
			tpsAvg: tps,
			costUsd,
			output: fullText,
		})
		setTaskStatus(db, task.id, "done", now)
		registry.recordSuccess(choice.instance.providerId)
		feedback.record(choice.instance.id, true)
		log(
			"info",
			"engine",
			`Execution ${execution.id} fertig (${tokensOut} Tokens, ${tps} tok/s, ${writtenCount} Dateien)`,
		)

		emit({
			event: "execution.usage",
			data: { executionId: execution.id, tokensIn, tokensOut, tps, costUsd },
		})
		emit({ event: "execution.done", data: { executionId: execution.id, taskId: task.id } })

		const done = getExecution(db, execution.id)
		if (!done) {
			throw new Error("Execution nach Finalisierung nicht lesbar")
		}
		return done
	}
}

/** Kurzer, sicherer Slug für den Workspace-Unterverzeichnis-Namen. */
function taskSlug(task: Task): string {
	const base = (task.title || task.prompt)
		.toLowerCase()
		.replace(/[^a-z0-9äöüß]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return (base.slice(0, 40) || "task").replace(/-+$/g, "")
}
