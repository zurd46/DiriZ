/**
 * Execution-Engine (`01-plan.md` §6–§7): Routing → Streaming →
 * Chunk-/Gesamt-Timeout → Failover (max. 2 Hops) → Persistenz →
 * Workspace-Dateien.
 *
 * Alles deterministisch nachvollziehbar: Die Routing-Entscheidung (Scores,
 * Ausschlüsse, Profile, Gewichte) wird pro Execution persistiert und als
 * `routing.decided`-Event emittiert.
 */

import fs from "node:fs"
import path from "node:path"
import {
	type Agent,
	type AgentProfile,
	type AgentScore,
	type CandidateScore,
	type ChatMessage,
	composeSystemPrompt,
	type CoreEvent,
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUTS,
	DEFAULT_WEIGHTS,
	type Execution,
	type HostMetrics,
	MAX_FAILOVER_HOPS,
	MIN_AGENT_SCORE,
	type ModelSettings,
	normalizeWeights,
	type ProviderType,
	type RoutePreview,
	type RoutingDecision,
	type ScoringWeights,
	scoreAgents,
	type Task,
	type TaskProfile,
	toAgentCandidate,
} from "@diriz/shared"
import type { Db } from "../db/connection.js"
import {
	appendChunk,
	createExecution,
	getAgent,
	getAgentDoc,
	getExecution,
	getInstance,
	getInstanceDoc,
	getProvider,
	getSetting,
	getSwarm,
	getTask,
	listAgents,
	saveAgentSelection,
	saveDecision,
	saveFile,
	setTaskAgentSelection,
	setTaskStatus,
	updateExecution,
} from "../db/repositories.js"
import type { LogEntry } from "../logger.js"
import { getHostMetrics } from "../monitoring/host.js"
import type { ProviderRegistry } from "../providers/registry.js"
import type { Feedback } from "../routing/feedback.js"
import type { PolicyCandidate } from "../routing/policies.js"
import { applyPolicies } from "../routing/policies.js"
import { extractProfile } from "../routing/profile.js"
import type { CandidateInfo } from "../routing/scorer.js"
import { scoreCandidate } from "../routing/scorer.js"
import { runAgentLoop } from "./agent.js"
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

/** Ergebnis der Agenten-Auswahl — rein, ohne Seiteneffekte (runTask & Preview). */
interface AgentSelection {
	agent?: Agent
	candidates: AgentScore[]
	reason: string
	/** false = ungültige Konfiguration → `runTask` schlägt die Task fehl. */
	ok: boolean
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

	/** Routing-Gewichte aus den Settings (Fallback: Plan-Defaults, §6.2). */
	private baseWeights(): ScoringWeights {
		const stored = getSetting<ScoringWeights>(this.deps.db, "routing_weights")
		return stored ? normalizeWeights(stored) : DEFAULT_WEIGHTS
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

	/** Alle Instanzen aller Provider als Policy-Kandidaten. Sperrzeit prüfen (§12.1). */
	/** Lokale Provider-Typen — laufen auf diesem Rechner (hostLoad-Achse, M8). */
	private static readonly LOCAL_TYPES: ProviderType[] = ["ollama", "lmstudio"]

	private async buildCandidates(): Promise<PolicyCandidate[]> {
		const { registry } = this.deps
		let host: HostMetrics | null = null
		try {
			host = await getHostMetrics()
		} catch {
			// Routing darf an Host-Metriken nicht scheitern → Achse bleibt neutral.
		}
		const instances = registry.instances()
		const result: PolicyCandidate[] = []
		const now = new Date().toISOString()
		for (const inst of instances) {
			// Gesperrte Instanzen überspringen (§12.1)
			if (inst.lockedUntil && inst.lockedUntil > now) {
				continue
			}
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
				local: ExecutionEngine.LOCAL_TYPES.includes(type),
				hostRamUsagePct: host?.ramUsagePct,
			}
			result.push({
				...info,
				providerType: type,
				providerOnline: providerStatus === "online" && !registry.isCircuitOpen(inst.providerId),
			})
		}
		return result
	}

	/* ---------------------------- Agent-Zuordnung (M1) --------------------------- */

	/**
	 * Wählt den Spezialisten für die Task je nach Zuweisungsmodus (rein, ohne
	 * Seiteneffekte — wird von `runTask` und der Routing-Preview genutzt):
	 * - `agent`: der feste Agent (task.agentId)
	 * - `swarm`: best bewertetes Mitglied des Swarms
	 * - `auto`: best bewerteter Agent, wenn er MIN_AGENT_SCORE erreicht — sonst keins
	 */
	private selectAgent(task: Task): AgentSelection {
		const mode = task.assignmentMode ?? "auto"
		const profile = extractProfile(task)
		const agentProfile: AgentProfile = {
			privacy: profile.privacy,
			requiredCapabilities: profile.requiredCapabilities,
			preferredCapabilities: profile.preferredCapabilities,
		}
		const pool = listAgents(this.deps.db).filter((a) => a.enabled)

		if (mode === "agent") {
			if (!task.agentId) {
				return { candidates: [], reason: 'Zuweisungsmodus "agent", aber kein Agent gewählt', ok: false }
			}
			const agent = getAgent(this.deps.db, task.agentId)
			if (!agent?.enabled) {
				return {
					candidates: [],
					reason: `Agent ${task.agentId} existiert nicht oder ist deaktiviert`,
					ok: false,
				}
			}
			const reason = "Manuell zugewiesener Spezialist"
			return {
				agent,
				candidates: [{ agentId: agent.id, name: agent.name, score: 0, reasons: [reason] }],
				reason,
				ok: true,
			}
		}

		if (mode === "swarm") {
			if (!task.swarmId) {
				return { candidates: [], reason: 'Zuweisungsmodus "swarm", aber kein Swarm gewählt', ok: false }
			}
			const swarm = getSwarm(this.deps.db, task.swarmId)
			if (!swarm?.enabled) {
				return {
					candidates: [],
					reason: `Swarm ${task.swarmId} existiert nicht oder ist deaktiviert`,
					ok: false,
				}
			}
			const members = pool.filter((a) => swarm.agentIds.includes(a.id))
			if (members.length === 0) {
				return { candidates: [], reason: `Swarm „${swarm.name}“ enthält keine aktiven Agenten`, ok: false }
			}
			const candidates = scoreAgents(task.prompt, agentProfile, members.map(toAgentCandidate))
			const agent = members.find((a) => a.id === candidates[0]?.agentId)
			return {
				agent,
				candidates,
				reason:
					members.length === 1
						? `Einziger Agent im Swarm „${swarm.name}“`
						: `Bester Agent im Swarm „${swarm.name}“`,
				ok: true,
			}
		}

		const candidates = scoreAgents(task.prompt, agentProfile, pool.map(toAgentCandidate))
		const best = candidates[0]
		if (best && best.score >= MIN_AGENT_SCORE) {
			return {
				agent: pool.find((a) => a.id === best.agentId),
				candidates,
				reason:
					best.reasons.length > 0
						? `Automatische Zuordnung: ${best.reasons.join("; ")}`
						: "Automatische Zuordnung",
				ok: true,
			}
		}
		return { candidates, reason: "Kein Spezialist relevant genug — freies Routing", ok: true }
	}

	/**
	 * Agenten-Auswahl mit Seiteneffekten: persistiert die Entscheidung und
	 * emittiert `task.agent_selected` (Explainability). Ungültige Konfiguration
	 * schlägt die Task fehl.
	 */
	private resolveAgent(task: Task): Agent | undefined {
		const { db, emit, log } = this.deps
		const mode = task.assignmentMode ?? "auto"
		const sel = this.selectAgent(task)
		if (!sel.ok) {
			setTaskStatus(db, task.id, "failed", new Date().toISOString())
			throw new Error(sel.reason)
		}

		saveAgentSelection(db, {
			taskId: task.id,
			mode,
			agentId: sel.agent?.id ?? null,
			agentName: sel.agent?.name,
			reason: sel.reason,
			candidates: sel.candidates,
			createdAt: new Date().toISOString(),
		})
		setTaskAgentSelection(db, task.id, sel.agent?.id ?? null)
		emit({
			event: "task.agent_selected",
			data: {
				taskId: task.id,
				agentId: sel.agent?.id ?? null,
				agentName: sel.agent?.name,
				mode,
				reason: sel.reason,
				candidates: sel.candidates,
			},
		})
		log(
			"info",
			"agents",
			`Task ${task.id}: ${sel.agent ? `Spezialist „${sel.agent.name}“` : "kein Agent"} (${mode})`,
		)
		return sel.agent
	}

	/**
	 * Routing-Preview / Dry-Run (M3): Führt exakt dieselbe Pipeline wie
	 * `runTask` durch (Profil → Policies → Scoring), aber ohne Execution,
	 * Persistenz oder Failover. Liefert die Entscheidung inkl. Scores und
	 * Ausschlüssen — oder `undefined`, wenn die Task nicht existiert.
	 */
	async preview(taskId: string): Promise<RoutePreview | undefined> {
		const task = getTask(this.deps.db, taskId)
		if (!task) {
			return undefined
		}
		const sel = this.selectAgent(task)
		const agent = sel.ok ? sel.agent : undefined
		const profile = this.applyAgentConstraints(extractProfile(task), agent)
		const candidates = await this.buildCandidates()
		const { weights, excluded, allowed } = applyPolicies(candidates, profile, this.baseWeights())
		const scored = allowed
			.map((c) => scoreCandidate(c, profile, weights, this.deps.feedback))
			.sort((a, b) => b.score - a.score)
		const ordered = this.orderByMode(scored, allowed, profile.mode, false)
		return {
			taskId: task.id,
			assignmentMode: task.assignmentMode ?? "auto",
			agentId: agent?.id,
			agentName: agent?.name,
			agentReason: sel.reason,
			decision: {
				executionId: "", // Dry-Run — noch keine Execution
				chosenInstanceId: ordered[0]?.instance.id,
				candidates: scored,
				excluded,
				profile,
				weights: weights as unknown as Record<string, number>,
				createdAt: new Date().toISOString(),
			},
			createdAt: new Date().toISOString(),
		}
	}

	/** Agent-Einschränkungen → Routing-Profil (Privacy, Fähigkeiten, Pins). */
	private applyAgentConstraints(profile: TaskProfile, agent?: Agent): TaskProfile {
		if (!agent) {
			return profile
		}
		let next: TaskProfile = { ...profile }
		if (agent.privacy === "local-only") {
			next = { ...next, privacy: "local-only" }
		}
		if (agent.requiredCapabilities.length > 0 || agent.preferredCapabilities.length > 0) {
			next = {
				...next,
				requiredCapabilities: [...new Set([...next.requiredCapabilities, ...agent.requiredCapabilities])],
				preferredCapabilities: [...new Set([...next.preferredCapabilities, ...agent.preferredCapabilities])],
			}
		}
		// Pins greifen nur, wenn die Task selbst nichts gepinnt hat.
		const taskPinned =
			next.mode === "pinned" || next.pinnedProviderId !== undefined || next.pinnedModelId !== undefined
		if (taskPinned) {
			return next
		}
		if (agent.pinnedInstanceId) {
			const inst = getInstance(this.deps.db, agent.pinnedInstanceId)
			if (inst) {
				return { ...next, mode: "pinned", pinnedProviderId: inst.providerId, pinnedModelId: inst.modelId }
			}
		}
		if (agent.pinnedProviderId) {
			return { ...next, mode: "pinned", pinnedProviderId: agent.pinnedProviderId }
		}
		return next
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

		// M1: Spezialisten-Zuordnung (auto/agent/swarm) vor dem Routing.
		const agent = this.resolveAgent(task)
		const profile = this.applyAgentConstraints(extractProfile(task), agent)
		const candidates = await this.buildCandidates()
		const { weights, excluded, allowed } = applyPolicies(candidates, profile, this.baseWeights())

		if (allowed.length === 0) {
			const reason = `Keine Instanz verfügbar (${excluded.length} ausgeschlossen)`
			log("warn", "routing", `${reason} für Task ${task.id}`)
			// Sichtbares Scheitern: Execution-Record, damit die UI den Fehler zeigt und bewerten kann.
			const execution = createExecution(db, { taskId: task.id })
			updateExecution(db, execution.id, {
				status: "failed",
				error: reason,
				finishedAt: new Date().toISOString(),
			})
			setTaskStatus(db, task.id, "failed")
			emit({ event: "execution.failed", data: { executionId: execution.id, taskId: task.id, error: reason } })
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
				return await this.streamExecution(execution, choice, agent)
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
	private orderByMode(
		scored: CandidateScore[],
		allowed: PolicyCandidate[],
		mode: string,
		advanceCursor = true,
	): PolicyCandidate[] {
		const byId = new Map(allowed.map((c) => [c.instance.id, c]))
		const ordered = scored
			.map((s) => byId.get(s.instanceId))
			.filter((c): c is PolicyCandidate => c !== undefined)
		if (mode !== "round-robin" || ordered.length <= 1) {
			return ordered
		}
		const provider = ordered[0].instance.providerId
		const cursor = this.roundRobinCursor.get(provider) ?? 0
		if (advanceCursor) {
			this.roundRobinCursor.set(provider, cursor + 1)
		}
		const start = cursor % ordered.length
		return [...ordered.slice(start), ...ordered.slice(0, start)]
	}

	/* -------------------------------- Streaming -------------------------------- */

	/**
	 * Streamt die Chat-Antwort: Deltas → Chunks persistieren + SSE-Event,
	 * Usage erfassen, am Ende Workspace-Dateien schreiben und finalisieren.
	 * Wirft bei Timeout/Abbruch/Provider-Fehler.
	 */
	private async streamExecution(
		execution: Execution,
		choice: PolicyCandidate,
		agent?: Agent,
	): Promise<Execution> {
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
			// Model-Settings auflösen: Provider ← Modell (`init.md`) ← Agent
			// (`init.md`) ← Task (späterer Eintrag gewinnt).
			const provider = getProvider(db, choice.instance.providerId)
			const effective: ModelSettings = {
				...provider?.modelSettings,
				...choice.instance.modelSettings,
				...agent?.modelSettings,
				...task.overrides,
			}
			// Der System-Prompt entsteht aus denselben Ebenen: der zuletzt gesetzte
			// gewinnt (Provider ← Instanz-`init.md` ← Agent-`init.md` ← Agenten-Feld
			// ← Task-Override). Zusätzlich wird die `plan.md` jeder Ebene als
			// verbindliche Arbeitsanweisung angehängt — das Modell arbeitet damit
			// genau so, wie das System es deklariert hat.
			const instancePlan = getInstanceDoc(db, choice.instance.id, "plan")?.content
			const agentPlan = agent ? getAgentDoc(db, agent.id, "plan")?.content : undefined
			const systemPrompt = composeSystemPrompt([
				{
					label: `Rechner ${provider?.label ?? choice.instance.providerId}`,
					systemPrompt: provider?.modelSettings?.systemPrompt,
				},
				{
					label: `Modell ${choice.instance.displayName}`,
					plan: instancePlan,
					systemPrompt: choice.instance.modelSettings?.systemPrompt,
				},
				{
					label: `Spezialist ${agent?.name ?? ""}`.trim(),
					plan: agentPlan,
					// Das Agenten-Feld schlägt den System-Prompt aus dessen `init.md`.
					systemPrompt: (agent?.systemPrompt ?? "").trim() || agent?.modelSettings?.systemPrompt,
				},
				{ label: "Task", systemPrompt: task.overrides?.systemPrompt },
			]).trim()
			const messages: ChatMessage[] = systemPrompt
				? [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: task.prompt },
					]
				: [{ role: "user", content: task.prompt }]

			if (task.metadata.agentMode === true && adapter.supportsTools) {
				// M8 Agentik: Tool-Loop statt Einzelstream — das Modell arbeitet
				// mit list_files/read_file/write_file in der Task-Sandbox.
				const baseDir = path.join(workspaceDir, taskSlug(task))
				fs.mkdirSync(baseDir, { recursive: true })
				log("info", "agent", `Agentik-Modus aktiv für Task ${task.id} (${choice.instance.modelId})`)
				const result = await runAgentLoop({
					adapter,
					model: choice.instance.modelId,
					settings: effective,
					systemPrompt: systemPrompt || undefined,
					userPrompt: task.prompt,
					baseDir,
					executionId: execution.id,
					signal: controller.signal,
					onDelta: (text) => {
						resetChunkTimer()
						fullText += text
						appendChunk(db, execution.id, seq++, text)
						emit({
							event: "execution.delta",
							data: { executionId: execution.id, delta: text, tokens: tokensOut },
						})
					},
					emitToolCall: (data) => {
						resetChunkTimer()
						emit({ event: "tool.call", data: { executionId: execution.id, ...data } })
					},
					log,
				})
				tokensIn = result.tokensIn
				tokensOut = result.tokensOut
			} else {
				const stream = adapter.chat({
					messages,
					model: choice.instance.modelId,
					settings: effective,
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
