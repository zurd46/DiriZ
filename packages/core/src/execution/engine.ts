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
import {
	type Agent,
	type AgentProfile,
	type AgentScore,
	type AgentSettings,
	type CandidateScore,
	type ChatMessage,
	type ConcurrencySettings,
	type CoreEvent,
	composeSystemPrompt,
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUTS,
	DEFAULT_WEIGHTS,
	type Execution,
	estimateTokens,
	extractDirective,
	fastWeights,
	type GitSettings,
	type HostMetrics,
	MAX_FAILOVER_HOPS,
	MIN_AGENT_SCORE,
	type ModelSettings,
	normalizeWeights,
	type ProviderType,
	qualityPriorOf,
	type RoutePreview,
	type RoutingDecision,
	type ScoringWeights,
	scoreAgents,
	type Task,
	type TaskMetadata,
	type TaskProfile,
	type TimeoutSettings,
	toAgentCandidate,
	workBranchName,
} from "@diriz/shared"
import type { Db } from "../db/connection.js"
import {
	appendChunk,
	appendToolCall,
	clearLoadFailures,
	createExecution,
	createTask,
	getAgent,
	getAgentDoc,
	getExecution,
	getInstance,
	getInstanceSpec,
	getProvider,
	getProviderDoc,
	getSetting,
	getSwarm,
	getTask,
	listAgents,
	listExecutionsByTask,
	listInstances,
	listTasks,
	listTasksByChain,
	listToolCallsByTask,
	lockInstance,
	recordLoadFailure,
	replayOutput,
	sameServerProviders,
	saveAgentSelection,
	saveDecision,
	saveFile,
	setTaskAgentSelection,
	setTaskChain,
	setTaskRepo,
	setTaskStatus,
	throughputByInstance,
	updateExecution,
} from "../db/repositories.js"
import { commitAll, isWorktree, push } from "../git/repo.js"
import type { LogEntry } from "../logger.js"
import { getHostMetrics } from "../monitoring/host.js"
import type { ProviderRegistry } from "../providers/registry.js"
import type { Feedback } from "../routing/feedback.js"
import type { PolicyCandidate } from "../routing/policies.js"
import { applyPolicies } from "../routing/policies.js"
import { extractProfile } from "../routing/profile.js"
import type { CandidateInfo } from "../routing/scorer.js"
import { scoreCandidate } from "../routing/scorer.js"
import { MAX_AGENT_STEPS, runAgentLoop } from "./agent.js"
import { parseFileBlocks, writeWorkspaceFilesAt } from "./files.js"
import { type CommandPolicy, DEFAULT_COMMAND_POLICY } from "./tools.js"
import { taskWorktreePath } from "./worktree.js"

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
	/**
	 * Arbeitsverzeichnis einer Task. Ohne Angabe der Slug-Ordner in der
	 * Workspace-Sandbox; mit gepinntem Repository ein Git-Worktree (M10).
	 */
	resolveTaskDir?: (task: Task) => Promise<string>
	/** GitHub-Token für automatisches Pushen (M10) — ohne bleibt es beim Commit. */
	githubToken?: () => string | undefined
}

interface ActiveRun {
	abort: AbortController
	taskId: string
	cancelled: boolean
	/** Rechner und Modell — Grundlage des GPU-Schutzes im Routing. */
	providerId?: string
	modelId?: string
	/** Das Gerät, auf dem wirklich gerechnet wird (siehe `geraetSchluessel`). */
	device?: string
}

/** Ergebnis der Agenten-Auswahl — rein, ohne Seiteneffekte (runTask & Preview). */
interface AgentSelection {
	agent?: Agent
	candidates: AgentScore[]
	reason: string
	/** false = ungültige Konfiguration → `runTask` schlägt die Task fehl. */
	ok: boolean
	/**
	 * Arbeitsablauf: alle Spezialisten in ihrer Reihenfolge. Gesetzt bei einem
	 * geordneten Swarm — die Task wird damit zum ersten Schritt einer Kette.
	 */
	chain?: string[]
}

/** Agentik-Läufe dürfen dreimal so lange dauern wie eine einzelne Antwort. */
const AGENT_TOTAL_FACTOR = 3

/** Konservative Basis-Qualität ohne Feedback-Historie. */
const BASIS_PRIOR = 0.6

/**
 * Die Stufen einer Kette. Altbestand ohne `stages` wird als Folge einzelner
 * Stufen gelesen — genau das Verhalten von vorher.
 */
function chainStages(chain: NonNullable<TaskMetadata["chain"]>): string[][] {
	if (chain.stages && chain.stages.length > 0) {
		return chain.stages
	}
	return chain.agentIds.map((id) => [id])
}

/**
 * Fasst Ausschlussgründe zusammen: „14× Provider offline · 11× fehlende
 * Fähigkeit · 4× Context-Fenster zu klein".
 *
 * Die Zahl allein sagt nichts. Wer liest, dass 29 Modelle ausgeschlossen
 * wurden, will wissen **warum** — und zwar sofort, nicht nach einer Reise durch
 * die Datenbank.
 */
export function summarizeExclusions(excluded: { reason: string }[]): string {
	const gezählt = new Map<string, number>()
	for (const e of excluded) {
		// Vor dem Doppelpunkt steht die Art, dahinter das Detail (Modellname,
		// Zahlen) — für die Zusammenfassung zählt die Art.
		const art = e.reason.split(":")[0]?.trim() ?? e.reason
		gezählt.set(art, (gezählt.get(art) ?? 0) + 1)
	}
	return [...gezählt.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([art, n]) => `${n}× ${art}`)
		.join(" · ")
}

/** Wie lange ein Modell gesperrt bleibt, das sich nicht laden liess. */
const MODEL_LOCK_MS = 10 * 60_000

/**
 * So viel Rückstand darf die Sichtung eines Modells haben, bevor es als
 * „nicht mehr angeboten" gilt.
 *
 * Die Bestandsaufnahme läuft alle zehn Sekunden; eine Minute Nachsicht deckt
 * einen ausgefallenen Rundgang ab, ohne ein wirklich verschwundenes Modell
 * lange mitzuschleppen. Gelöscht wird nichts: Wer „LM Link" wieder einschaltet,
 * bekommt seine Modelle samt Datenblatt und Einstellungen zurück.
 */
const STALE_GRACE_MS = 60_000

/**
 * Sperrdauer nach dem n-ten Ladefehler in Folge.
 *
 * Ein Modell, das 158 GB verlangt, wird auch in zehn Minuten nicht kleiner.
 * Trotzdem darf der erste Fehlschlag kein Urteil sein — der Speicher kann
 * schlicht belegt gewesen sein. Deshalb die Treppe: kurz, dann länger, dann
 * einen Tag. Jeder erfolgreiche Lauf setzt den Zähler zurück.
 */
export function lockDurationMs(failures: number): number {
	if (failures >= 4) {
		return 24 * 60 * 60_000
	}
	if (failures === 3) {
		return 6 * 60 * 60_000
	}
	if (failures === 2) {
		return 60 * 60_000
	}
	return MODEL_LOCK_MS
}

/** „10 min“, „1 h“, „24 h“ — für Log-Zeilen, die ein Mensch liest. */
function formatDauer(ms: number): string {
	return ms < 60 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`
}

/**
 * Sagt der Fehlertext, dass das **Modell** nicht geladen werden konnte?
 *
 * Der Unterschied zählt: Ein Server, der nicht antwortet, betrifft alle seine
 * Modelle (dafür gibt es den Circuit-Breaker). Ein Modell, das nicht in den
 * Speicher passt oder dessen Engine abbricht, betrifft nur dieses eine — und
 * es wieder und wieder zu wählen, kostet jedes Mal eine Minute Ladeversuch.
 */
export function looksLikeLoadFailure(error: string): boolean {
	// `model is unloaded` gehört dazu, obwohl es kein Ladefehler ist: Es ist die
	// **Folge** eines fremden Ladevorgangs. Live nachgestellt — zwei Modelle
	// gleichzeitig an denselben LM-Studio-Server, und der laufende Stream endet
	// mitten im Satz mit genau dieser Meldung. Die Antwort darauf ist dieselbe
	// wie bei einem Ladefehler: warten, dann das nehmen, was schon im Speicher
	// liegt.
	return /failed to load model|engine protocol|model not found|no such model|out of memory|insufficient memory|model is unloaded/i.test(
		error,
	)
}

/**
 * Wie lange ein Rechner nach einem Ladefehler in Ruhe gelassen wird.
 *
 * Gemessen, nicht geschätzt: Nach einem gescheiterten Ladeversuch scheiterten
 * an derselben LM-Studio-Instanz auch die **nächsten zwei** Anfragen — für ein
 * völlig gesundes Modell —, und erst die dritte lief (nach 16 s). Wer sofort
 * das nächste Modell probiert, erzeugt aus einem Fehler eine Lawine; genau das
 * stand in den Protokollen: drei Modelle hintereinander, alle „HTTP 500".
 */
const MACHINE_COOLDOWN_MS = 15_000

/**
 * Das kleinere von „was das Modell kann" und „was gerade geladen ist".
 *
 * Beides wird gebraucht: Die Fähigkeit gehört ins Routing (ein Modell mit
 * 262 k Fenster ist für lange Aufgaben der bessere Kandidat), die geladene
 * Grösse in die Rechnung (mehr passt heute nicht hinein).
 */
export function wirksamesFenster(instance: { contextWindow: number; loadedContextWindow?: number }): number {
	const geladen = instance.loadedContextWindow
	return geladen && geladen > 0 ? Math.min(instance.contextWindow, geladen) : instance.contextWindow
}

/** So viel Vorarbeit reicht ein Kettenschritt weiter (Zeichen). */
const HANDOFF_MAX_CHARS = 6000

/**
 * Kürzt Markdown, ohne es kaputt zu machen.
 *
 * Ein blosses `slice()` schneidet mitten in eine Zeile oder — schlimmer —
 * mitten in einen Code-Block. Die offene ```-Zaunzeile verschluckt dann alles
 * Folgende, und die Übergabe erscheint als eine einzige unformatierte Wand.
 * Deshalb: an einer Zeilengrenze abschneiden, offene Zäune schliessen und die
 * Kürzung sichtbar machen.
 */
export function trimMarkdown(markdown: string, maxChars: number): string {
	const text = markdown ?? ""
	if (text.length <= maxChars) {
		return text
	}
	const cut = text.slice(0, maxChars)
	const lines = cut.slice(0, cut.lastIndexOf("\n") + 1 || cut.length).split(/\r?\n/)
	// Zaunzeilen zählen: ungerade Anzahl heisst, ein Block steht noch offen.
	const fences = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length
	if (fences % 2 === 1) {
		lines.push("```")
	}
	lines.push("", "_[… gekürzt — die vollständige Antwort steht beim vorigen Schritt.]_")
	return lines.join("\n")
}

/**
 * Teilergebnis eines gescheiterten Laufs — Text, sonst der Gedankengang.
 *
 * Beides ist wertvoll: Der Text ist die halbe Antwort, der Gedankengang zeigt,
 * wie weit das Modell kam und woran es hängen blieb.
 */
function partialOutput(text: string, reasoning: string): string | undefined {
	if (text.trim().length > 0) {
		return `${text}\n\n[Abgebrochen — dies ist der Stand bis zum Fehler.]`
	}
	if (reasoning.trim().length > 0) {
		return `[Abgebrochen, keine Antwort — nur der Gedankengang bis zum Fehler.]\n\n${reasoning}`
	}
	return undefined
}

/** Positive ganze Zahl aus den Einstellungen, sonst der Default. */
function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

export class ExecutionEngine {
	private active = new Map<string, ActiveRun>()
	/**
	 * Gedankengang je laufender Execution. Der Stream lebt eine Ebene tiefer als
	 * die Fehlerbehandlung; ohne diese Ablage wäre bei einem Timeout nicht mehr
	 * daran heranzukommen — und genau dann braucht man ihn.
	 */
	private reasoningByExecution = new Map<string, string>()
	private roundRobinCursor = new Map<string, number>()

	constructor(private deps: EngineDeps) {}

	get activeCount(): number {
		return this.active.size
	}

	/**
	 * Zeitgrenzen (Einstellungen, sonst Umgebung bzw. Plan-Defaults).
	 *
	 * Agentik-Läufe bekommen die **dreifache** Gesamtdauer: Sie lesen Dateien,
	 * denken nach und antworten in mehreren Schritten — mit derselben Frist wie
	 * eine einzelne Antwort scheitern sie regelmässig kurz vor dem Ziel und die
	 * gesamte Arbeit ist verloren.
	 */
	timeouts(agentMode = false): TimeoutSettings {
		const stored = getSetting<Partial<TimeoutSettings>>(this.deps.db, "timeouts")
		const totalMs = positive(stored?.totalMs, DEFAULT_TIMEOUTS.totalMs)
		return {
			firstChunkMs: positive(stored?.firstChunkMs, DEFAULT_TIMEOUTS.firstChunkMs),
			chunkMs: positive(stored?.chunkMs, DEFAULT_TIMEOUTS.chunkMs),
			totalMs: agentMode ? totalMs * AGENT_TOTAL_FACTOR : totalMs,
		}
	}

	/** Parallelitäts- und GPU-Grenzen (Einstellungen, sonst Plan-Defaults). */
	limits(): ConcurrencySettings {
		const stored = getSetting<Partial<ConcurrencySettings>>(this.deps.db, "concurrency")
		return {
			global: positive(stored?.global, DEFAULT_CONCURRENCY.global),
			perProvider: positive(stored?.perProvider, DEFAULT_CONCURRENCY.perProvider),
			maxModelsPerProvider: positive(stored?.maxModelsPerProvider, DEFAULT_CONCURRENCY.maxModelsPerProvider),
		}
	}

	get concurrencyLimit(): number {
		return this.limits().global
	}

	/**
	 * Regelwerk fürs Ausführen von Befehlen (`settings.commands`).
	 *
	 * Absichtlich hier und nicht im Werkzeug selbst: Was ein Modell starten
	 * darf, ist eine Betriebsentscheidung — sie gehört in die Einstellungen,
	 * nicht in den Code.
	 */
	commandPolicy(): CommandPolicy {
		const stored = getSetting<Partial<CommandPolicy>>(this.deps.db, "commands")
		return {
			enabled: stored?.enabled !== false,
			allowed:
				Array.isArray(stored?.allowed) && stored.allowed.length > 0
					? stored.allowed
					: DEFAULT_COMMAND_POLICY.allowed,
			timeoutMs:
				typeof stored?.timeoutMs === "number" && stored.timeoutMs > 0
					? stored.timeoutMs
					: DEFAULT_COMMAND_POLICY.timeoutMs,
		}
	}

	/** Agentik-Einstellungen (Tool-Budget; 0 = unbegrenzt). */
	agentSettings(): AgentSettings {
		const stored = getSetting<Partial<AgentSettings>>(this.deps.db, "agent")
		const raw = stored?.maxSteps
		return {
			maxSteps: typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : MAX_AGENT_STEPS,
		}
	}

	/**
	 * Schaltet eine Kette eine **Stufe** weiter.
	 *
	 * Eine Kette ist keine Perlenschnur, sondern ein Wertstrom mit Stufen:
	 * Innerhalb einer Stufe arbeiten alle Spezialisten **gleichzeitig** — dann
	 * rechnen alle angebundenen Rechner statt einer, während die anderen
	 * danebenstehen. Die nächste Stufe beginnt erst, wenn die vorige
	 * vollständig fertig ist; sie bekommt die Ergebnisse **aller** ihrer
	 * Vorgänger als Vorarbeit.
	 *
	 * Aufgerufen wird das nach jedem Schritt. Läuft ein Geschwisterschritt noch,
	 * passiert nichts — wer als Letzter fertig wird, zieht die Kette weiter.
	 *
	 * Abgebrochen wird still: Liefert eine ganze Stufe nichts, endet die Kette
	 * dort — auf falschem Fundament weiterzubauen kostet mehr als aufzuhören.
	 */
	private startNextChainStep(task: Task, ergebnis: string): void {
		const chain = task.metadata.chain
		if (!chain) {
			return
		}
		const stages = chainStages(chain)
		const stage = chain.stage ?? chain.index ?? 0

		// Geschwister derselben Stufe: Solange einer noch arbeitet, wartet die
		// Kette. Ohne diese Sperre startete jeder fertige Schritt die nächste
		// Stufe erneut — die Arbeit liefe mehrfach.
		const geschwister = this.chainTasks(chain, task).filter(
			(t) => (t.metadata.chain?.stage ?? t.metadata.chain?.index ?? 0) === stage,
		)
		const offen = geschwister.filter(
			(t) => t.id !== task.id && !["done", "failed", "cancelled"].includes(t.status),
		)
		if (offen.length > 0) {
			this.deps.log(
				"info",
				"agents",
				`Kette: Stufe ${stage + 1} noch nicht fertig — ${offen.length} Schritt(e) laufen`,
			)
			return
		}

		const nextStage = stages[stage + 1]
		if (!nextStage || nextStage.length === 0) {
			return
		}

		// Vorarbeit dieser Stufe: die Ergebnisse **aller** Geschwister, jeweils
		// mit dem Namen ihres Spezialisten — sonst weiss die nächste Stufe
		// nicht, wessen Aussage sie vor sich hat.
		const beitraege = geschwister
			.map((t) => {
				const text =
					t.id === task.id ? ergebnis : (listExecutionsByTask(this.deps.db, t.id).at(-1)?.output ?? "")
				const name = getAgent(this.deps.db, t.agentId ?? "")?.name
				return { name: name ?? "Spezialist", text: text.trim() }
			})
			.filter((b) => b.text.length > 0)

		const budget = Math.max(1500, Math.floor(HANDOFF_MAX_CHARS / Math.max(1, beitraege.length)))
		const vorarbeit =
			beitraege.length === 0
				? "_(keine Textantwort)_"
				: beitraege
						.map((b) =>
							beitraege.length === 1
								? trimMarkdown(b.text, HANDOFF_MAX_CHARS)
								: `### ${b.name}\n\n${trimMarkdown(b.text, budget)}`,
						)
						.join("\n\n")

		const ziel = chain.goal ?? task.prompt
		const chainId = chain.id ?? task.id
		const rootTaskId = chain.rootTaskId ?? task.id

		// Was die vorige Stufe schon gelesen hat: Der nächste Spezialist arbeitet
		// im selben Verzeichnis und muss dieselben Dateien nicht noch einmal
		// durchlesen — jedes erneute Lesen kostet Zeit und bläht den Kontext.
		const gelesen = [
			...new Set(
				geschwister.flatMap((t) =>
					listToolCallsByTask(this.deps.db, t.id)
						.filter((c) => c.ok && c.name === "read_file")
						.map((c) => c.argsSummary),
				),
			),
		].slice(0, 40)
		let gestartet = 0
		for (const agentId of nextStage) {
			const agent = getAgent(this.deps.db, agentId)
			if (!agent?.enabled) {
				this.deps.log("warn", "agents", `Kette: Spezialist ${agentId} fehlt oder ist deaktiviert`)
				continue
			}
			const folge = createTask(this.deps.db, {
				title: task.title,
				// Sauberes Markdown: Die Übergabe landet im Chat vor Augen und im
				// Prompt vor dem Modell. Überschriften statt „Label:"-Zeilen halten
				// beides lesbar — und die Vorarbeit ist selbst schon Markdown.
				prompt: [
					"## Ursprünglicher Auftrag",
					"",
					ziel.trim(),
					"",
					`## Vorarbeit aus Stufe ${stage + 1}`,
					"",
					vorarbeit,
					...(gelesen.length > 0
						? [
								"",
								"## Bereits gelesen",
								"",
								"Diese Dateien hat die vorige Stufe im **selben** Arbeitsverzeichnis schon gelesen;",
								"ihr Stand steht oben. Lies sie nur erneut, wenn du eine konkrete Stelle brauchst:",
								"",
								...gelesen.map((f) => `- ${f}`),
							]
						: []),
					"",
					"## Deine Aufgabe",
					"",
					"Bau darauf auf und erledige den Teil, für den du zuständig bist. " +
						"Wiederhole die Vorarbeit nicht, sondern ergänze oder korrigiere sie. " +
						"Du arbeitest im selben Arbeitsverzeichnis wie die vorige Stufe — ihre Änderungen " +
						"liegen bereits vor dir.",
				].join("\n"),
				metadata: {
					...task.metadata,
					chain: {
						...chain,
						id: chainId,
						rootTaskId,
						stages,
						stage: stage + 1,
						index: stages.slice(0, stage + 1).reduce((n, s) => n + s.length, 0),
						goal: ziel,
					},
				},
				assignmentMode: "agent",
				agentId,
				repoId: task.repoId ?? null,
				baseBranch: task.baseBranch ?? null,
			})
			// Auf demselben Arbeitsbranch weiterbauen: Sonst zweigte jede Stufe
			// erneut von `main` ab und die Arbeit der vorigen wäre verloren.
			if (task.repoId && task.workBranch) {
				setTaskRepo(this.deps.db, folge.id, { workBranch: task.workBranch })
			}
			this.deps.emit({ event: "task.created", data: { taskId: folge.id } })
			this.deps.log(
				"info",
				"agents",
				`Kette: Stufe ${stage + 2}/${stages.length} an ${agent.name} (Task ${folge.id})`,
			)
			const accepted = this.start(folge.id)
			if (accepted.accepted) {
				gestartet++
			} else {
				// Kein Verlust: Die Task wartet und wird gestartet, sobald wieder
				// Kapazität frei wird (`drainQueued`).
				setTaskStatus(this.deps.db, folge.id, "queued")
				this.deps.log("info", "agents", `Kette: ${agent.name} wartet auf Kapazität (${accepted.reason})`)
			}
		}
		if (gestartet === 0) {
			this.deps.log("warn", "agents", `Kette: Stufe ${stage + 2} konnte nicht starten`)
		}
	}

	/**
	 * Stellt die noch offenen Versuche um: bereits **geladene** Modelle zuerst.
	 *
	 * Nur für den Fall, dass ein Ladevorgang gescheitert ist. Dann ist der
	 * Speicher belegt, und der beste Score nützt nichts — ein Modell, das schon
	 * im Speicher liegt, braucht keinen Ladevorgang und kann nicht daran
	 * scheitern. Die bereits abgearbeiteten Versuche bleiben unangetastet,
	 * sonst liefe die Kette rückwärts.
	 */
	private preferLoaded(ordered: PolicyCandidate[], from: number): PolicyCandidate[] {
		const rest = ordered.slice(from)
		const geladen = (c: PolicyCandidate) =>
			this.deps.registry.loadedModelsOf(c.instance.providerId).includes(c.instance.modelId)
		return [...ordered.slice(0, from), ...rest.filter(geladen), ...rest.filter((c) => !geladen(c))]
	}

	/** Alle Tasks derselben Kette — über die gemeinsame Kennung. */
	private chainTasks(chain: NonNullable<TaskMetadata["chain"]>, self: Task): Task[] {
		const id = chain.id
		if (!id) {
			// Altbestand ohne Kennung: Dort war jede Stufe einelementig, die Task
			// selbst ist also ihre eigene Stufe.
			return [self]
		}
		// Gezielt statt alles: `listTasks` lädt sonst bei jedem Abschluss den
		// gesamten Bestand, nur um drei Geschwister zu finden.
		return listTasksByChain(this.deps.db, id)
	}

	/**
	 * Wartende Aufträge starten, sobald Kapazität frei wird.
	 *
	 * Ohne das bliebe eine parallele Stufe unvollständig: Was am
	 * Parallelitäts-Limit abprallt, würde nie wieder angefasst — und die
	 * nächste Stufe wartete ewig auf einen Schritt, der nie lief. Dasselbe gilt
	 * für eine einzelne Task, die alle Rechner beschäftigt vorfand.
	 */
	private drainQueued(): void {
		for (const t of listTasks(this.deps.db, { status: "queued" })) {
			if (this.activeCount >= this.concurrencyLimit) {
				return
			}
			if (!this.isRunning(t.id)) {
				this.start(t.id)
			}
		}
	}

	/** Einstellungen zur Repository-Arbeit (Auto-Commit / Auto-Push). */
	gitSettings(): GitSettings {
		const stored = getSetting<Partial<GitSettings>>(this.deps.db, "git")
		return {
			autoCommit: stored?.autoCommit !== false,
			autoPush: stored?.autoPush !== false,
		}
	}

	/**
	 * Sichert die Arbeit einer Task im Repository: committen und — sofern
	 * eingeschaltet — auf den **Arbeitsbranch** pushen.
	 *
	 * Immer auf `diriz/…`, nie auf den Basis-Branch: Was ein Modell schreibt,
	 * gehört auf einen eigenen Zweig, den man ansehen und verwerfen kann. Ohne
	 * Auto-Commit bliebe die Arbeit als uncommitteter Stand im Worktree liegen
	 * und wäre beim nächsten Lauf schwer von neuem zu unterscheiden.
	 */
	private async autoCommit(task: Task): Promise<void> {
		if (!task.repoId) {
			return
		}
		const { autoCommit, autoPush } = this.gitSettings()
		if (!autoCommit) {
			return
		}
		const dir = await this.taskDir(task)
		if (!isWorktree(dir)) {
			return
		}
		try {
			const branch = task.workBranch ?? workBranchName(task.title || task.id, task.id)
			// Der Commit nennt den Spezialisten und die Stufe: Auf einem
			// gemeinsamen Branch arbeiten mehrere nacheinander, und hinterher
			// will man sehen, wer was beigetragen hat — und eine einzelne Stufe
			// verwerfen können, statt alles.
			const agent = task.agentId ? getAgent(this.deps.db, task.agentId)?.name : undefined
			const chain = task.metadata.chain
			const stufe =
				chain?.stages && chain.stages.length > 1
					? ` (Stufe ${(chain.stage ?? chain.index) + 1}/${chain.stages.length})`
					: ""
			const kopf = `${task.title?.trim() || "DiriZ-Änderung"}${agent ? ` — ${agent}` : ""}${stufe}`
			const result = await commitAll({
				worktreePath: dir,
				message: `${kopf}\n\nAutomatisch committet von DiriZ (Task ${task.id}).`,
			})
			if (!result) {
				return
			}
			this.deps.log(
				"info",
				"git",
				`Task ${task.id}: Commit ${result.shortSha} auf ${branch} (${result.filesChanged} Datei(en))`,
			)
			if (!autoPush) {
				return
			}
			const token = this.deps.githubToken?.()
			await push({ worktreePath: dir, branch, token })
			setTaskRepo(this.deps.db, task.id, { pushedAt: new Date().toISOString() })
			this.deps.emit({ event: "task.pushed", data: { taskId: task.id, branch, toBase: false } })
			this.deps.log("info", "git", `Task ${task.id}: ${branch} zu GitHub gepusht`)
		} catch (e) {
			// Ein gescheiterter Push macht die Antwort nicht ungültig — die
			// Änderungen liegen im Worktree und lassen sich von Hand pushen.
			this.deps.log(
				"warn",
				"git",
				`Task ${task.id}: Automatisches Sichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
	}

	/** Gedankengang eines laufenden Streams anhängen. */
	private appendReasoning(executionId: string, text: string): void {
		this.reasoningByExecution.set(executionId, (this.reasoningByExecution.get(executionId) ?? "") + text)
	}

	/** Was läuft gerade auf einem Rechner? (Anzahl + belegte Modell-Plätze) */
	/** Arbeitet dieser Rechner gerade? Das Warmhalten hält sich davon fern. */
	isProviderBusy(providerId: string): boolean {
		// Ein Rechner gilt als beschäftigt, wenn **irgendeines** seiner Geräte
		// arbeitet — das Warmhalten soll keiner laufenden Antwort in die Quere
		// kommen, auch nicht über einen durchgereichten Weg.
		return listInstances(this.deps.db, providerId).some((i) => this.activityOf(i).count > 0)
	}

	/**
	 * Was gerade auf **einem Gerät** läuft — Grundlage des GPU-Schutzes.
	 *
	 * Die Einheit ist die Grafikkarte, nicht der Endpunkt. Der Unterschied ist
	 * bei diesem Aufbau entscheidend: Auf dem Mac läuft LM Studio, das über
	 * „LM Link" die Modelle eines Windows-Rechners **durchreicht**. Zwei
	 * Anfragen an denselben Mac-Endpunkt können also auf zwei verschiedenen
	 * Rechnern landen — und zwei Anfragen an verschiedene Endpunkte auf
	 * demselben. Wer nach Endpunkt zählt, schützt das Falsche und bremst das
	 * Falsche.
	 *
	 * Nachgewiesen: Ein zweites Modell auf derselben Karte wirft das laufende
	 * mitten im Stream aus dem Speicher — die Antwort stirbt mit einer
	 * HTTP-500-Fehlerseite.
	 */
	private activityOf(instance: { providerId: string; deviceName?: string }): {
		count: number
		models: string[]
	} {
		const ziel = this.geraetSchluessel(instance)
		const models = new Set<string>()
		let count = 0
		for (const run of this.active.values()) {
			if (!run.providerId || (run.device ?? "") !== ziel) {
				continue
			}
			count++
			if (run.modelId) {
				models.add(run.modelId)
			}
		}
		return { count, models: [...models] }
	}

	/**
	 * Der Schlüssel des Geräts, auf dem ein Modell rechnet.
	 *
	 * Erste Wahl ist der Gerätename aus LM Studio (`instances.device_name`) —
	 * er ist gemessen, nicht geraten. Fehlt er (Tunnel, Ollama, Cloud), zählt
	 * die Gruppe deckungsgleicher Provider: besser als nichts und nie falsch
	 * zusammenfassend.
	 */
	private geraetSchluessel(instance: { providerId: string; deviceName?: string }): string {
		if (instance.deviceName) {
			return `geraet:${instance.deviceName}`
		}
		// Was der Mensch erklärt hat, zählt vor jeder Vermutung: Über einen
		// Tunnel kann DiriZ das Gerät nicht messen.
		const erklaert = getProvider(this.deps.db, instance.providerId)?.config?.deviceName
		if (typeof erklaert === "string" && erklaert.length > 0) {
			return `geraet:${erklaert}`
		}
		const gruppe = sameServerProviders(this.deps.db, instance.providerId).sort()
		return `zugang:${gruppe.join("+")}`
	}

	/**
	 * Pause zwischen zwei Failover-Versuchen auf derselben Maschine.
	 *
	 * In Sekundenschritten, damit ein Abbruch durch den Nutzer nicht erst nach
	 * der vollen Wartezeit wirkt — wer auf „Abbrechen" drückt, meint jetzt.
	 */
	private async abkuehlen(ms: number, executionId: string): Promise<void> {
		const bis = Date.now() + ms
		while (Date.now() < bis) {
			if (this.active.get(executionId)?.cancelled) {
				return
			}
			await new Promise((r) => setTimeout(r, Math.min(1000, bis - Date.now())))
		}
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
		// Was liegt gerade auf den Grafikkarten? Ohne diese Auskunft könnte das
		// Routing keinen Ladevorgang vermeiden (und der kostet Minuten).
		await registry.refreshLoads()
		let host: HostMetrics | null = null
		try {
			host = await getHostMetrics()
		} catch {
			// Routing darf an Host-Metriken nicht scheitern → Achse bleibt neutral.
		}
		// Einmal je Routing-Runde: gemessener Durchsatz aller Modelle.
		const tps = throughputByInstance(this.deps.db)
		const instances = registry.instances()
		const result: PolicyCandidate[] = []
		const now = new Date().toISOString()
		// Je Rechner die jüngste Sichtung — Massstab dafür, was noch im Bestand ist.
		const neuesteSichtung = new Map<string, number>()
		for (const i of instances) {
			const t = Date.parse(i.lastSeenAt)
			if (Number.isFinite(t)) {
				neuesteSichtung.set(i.providerId, Math.max(neuesteSichtung.get(i.providerId) ?? 0, t))
			}
		}
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
			// Das Datenblatt (`llm.md`) des Modells: Es liefert die Eignungs-Achse
			// (Stärken/Schwächen gegen den Prompt) und die Qualitätsklasse als
			// Startwert — bis genug echtes Feedback vorliegt, das ihn ablöst.
			const spec = getInstanceSpec(this.deps.db, inst.id)
			const info: CandidateInfo = {
				instance: inst,
				loadFactor: registry.loadFactorOf(inst.providerId, inst.modelId),
				providerLatencyMs: p50,
				basisPrior: spec ? qualityPriorOf(spec) : BASIS_PRIOR,
				spec,
				tokensPerSecond: tps.get(inst.id),
				local: ExecutionEngine.LOCAL_TYPES.includes(type),
				hostRamUsagePct: host?.ramUsagePct,
			}
			const activity = this.activityOf(inst)
			// **Steht das Modell noch im Bestand des Rechners?**
			//
			// Gemessen wird gegen die jüngste Sichtung **desselben Rechners**,
			// nicht gegen die Uhr: Wurde ein Provider gerade gar nicht befragt,
			// sind alle seine Modelle gleich alt und keines gilt als
			// verschwunden. Erst wenn eine Bestandsaufnahme gelang und ein
			// Modell dabei fehlte, fällt es zurück.
			const juengste = neuesteSichtung.get(inst.providerId)
			const stale = juengste !== undefined && juengste - Date.parse(inst.lastSeenAt) > STALE_GRACE_MS
			result.push({
				...info,
				providerType: type,
				providerOnline: providerStatus === "online" && !registry.isCircuitOpen(inst.providerId),
				providerActiveCount: activity.count,
				providerActiveModels: activity.models,
				instanceStale: stale,
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
			// Arbeitsablauf: Alle Mitglieder nacheinander, in ihrer Reihenfolge.
			// Die Kette selbst legt `runTask` an, sobald der erste Schritt steht.
			if (swarm.ordered && members.length > 1) {
				const ordered = swarm.agentIds
					.map((id) => members.find((m) => m.id === id))
					.filter((m): m is Agent => m !== undefined)
				const erster = ordered[0]
				if (erster) {
					return {
						agent: erster,
						candidates: scoreAgents(task.prompt, agentProfile, ordered.map(toAgentCandidate)),
						reason: `Arbeitsablauf „${swarm.name}": Schritt 1 von ${ordered.length}`,
						ok: true,
						chain: ordered.map((a) => a.id),
					}
				}
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
		// Arbeitsablauf: Die Kette in den Metadaten verankern, damit der Core
		// nach diesem Schritt selbst weitermacht. Nur beim ersten Schritt —
		// Folge-Tasks bringen ihre Kette bereits mit.
		if (sel.chain && sel.chain.length > 1 && !task.metadata.chain) {
			setTaskChain(db, task.id, { agentIds: sel.chain, index: 0, goal: task.prompt })
			task.metadata = { ...task.metadata, chain: { agentIds: sel.chain, index: 0, goal: task.prompt } }
		}
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
		// Dieselben Gewichte wie im echten Lauf — eine Vorschau, die anders
		// rechnet als die Ausführung, ist keine Vorschau.
		const { weights, excluded, allowed } = applyPolicies(
			candidates,
			profile,
			task.metadata.speed === "fast" ? fastWeights(this.baseWeights()) : this.baseWeights(),
			this.limits(),
			(id) => this.deps.registry.labelOf(id),
			(id) => sameServerProviders(this.deps.db, id),
		)
		const scored = allowed
			.map((c) => scoreCandidate(c, profile, weights, this.deps.feedback, task.prompt))
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
		// Der System-Prompt zählt zum Kontextbedarf. Seit `plan.md` als
		// verbindliche Arbeitsanweisung mitgeschickt wird, kann er tausende
		// Tokens umfassen — ohne ihn hier einzurechnen hielte das Context-Gate
		// ein Modell für passend, dessen Fenster in Wahrheit überläuft.
		const overhead = this.agentPromptTokens(agent)
		if (overhead > 0) {
			next = { ...next, estTokens: next.estTokens + overhead }
		}
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

	/**
	 * Wie viele Tokens der Spezialist selbst in den Prompt einbringt:
	 * sein System-Prompt plus die Arbeitsanweisung aus `plan.md`.
	 */
	private agentPromptTokens(agent: Agent): number {
		const parts = [
			(agent.systemPrompt ?? "").trim() || (agent.modelSettings?.systemPrompt ?? ""),
			extractDirective(getAgentDoc(this.deps.db, agent.id, "plan")?.content ?? "") ?? "",
		]
		const text = parts.filter((p) => p.length > 0).join("\n\n")
		// `0` als erwartete Ausgabe: Der Ausgabe-Puffer steckt bereits in
		// `estTokens` der Task — sonst würde er doppelt gezählt.
		return text.length > 0 ? estimateTokens(text, 0) : 0
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
		// Schnellmodus: Tempo zählt dreifach (siehe `fastWeights`).
		const gewichte = task.metadata.speed === "fast" ? fastWeights(this.baseWeights()) : this.baseWeights()
		const rechnerName = (id: string) => this.deps.registry.labelOf(id)
		const gleicheMaschine = (id: string) => sameServerProviders(this.deps.db, id)
		let policy = applyPolicies(candidates, profile, gewichte, this.limits(), rechnerName, gleicheMaschine)

		// Kein Kandidat? Erst prüfen, **warum** — scheitern ist die letzte
		// Antwort, nicht die erste.
		//
		// Der Versuch entscheidet, nicht die Buchführung: Früher musste **jeder**
		// Ausschluss dieselbe Ursache haben, damit gelockert wurde. Bei gemischten
		// Gründen (ein Rechner offline **und** fehlende Fähigkeiten) griff die
		// Lockerung nie — obwohl auf dem anderen Rechner brauchbare Modelle
		// standen. Jetzt wird die Lockerung schlicht durchgerechnet.
		if (policy.allowed.length === 0 && profile.requiredCapabilities.length > 0) {
			// Nicht um jeden Preis: Ein Modell **ohne jede** Fähigkeit ist kein
			// schwächeres Werkzeug, sondern gar keines — Einbettungs- und
			// Rerank-Modelle beantworten keine Aufträge. Sie bleiben draussen,
			// sonst käme statt einer Antwort ein Vektor zurück.
			const gelockert = applyPolicies(
				candidates.filter((c) => c.instance.capabilities.length > 0),
				{ ...profile, requiredCapabilities: [], preferredCapabilities: profile.requiredCapabilities },
				gewichte,
				this.limits(),
				rechnerName,
				gleicheMaschine,
			)
			if (gelockert.allowed.length > 0) {
				log(
					"warn",
					"routing",
					`Task ${task.id}: kein Modell mit ${profile.requiredCapabilities.join(", ")} — ` +
						"Fähigkeits-Gate gelockert, es wird das bestbewertete verfügbare Modell genommen",
				)
				policy = gelockert
			}
		}
		if (policy.allowed.length === 0 && policy.onlyBusy) {
			// Alle Rechner arbeiten gerade. Die Task ist nicht unmöglich, nur zu
			// früh: Sie wartet und wird gestartet, sobald etwas frei wird.
			setTaskStatus(db, task.id, "queued")
			log("info", "routing", `Task ${task.id} wartet: alle Rechner ausgelastet`)
			throw new NoCandidateError()
		}
		const { weights, excluded, allowed } = policy

		if (allowed.length === 0) {
			// **Die Begründung mitgeben, nicht wegwerfen.** „Keine Instanz
			// verfügbar (29 ausgeschlossen)" ist keine Auskunft, sondern eine
			// Zumutung: Wer das liest, muss in der Datenbank nachsehen, um zu
			// erfahren, ob ein Rechner offline war, eine Fähigkeit fehlte oder der
			// Prompt schlicht zu lang ist. Also steht es jetzt in der Meldung —
			// und die vollständige Entscheidung landet wie jede andere in der
			// Datenbank.
			// Ein Pin auf einen Rechner, den es im Rennen gar nicht gibt
			// (deaktiviert, offline, gelöscht), ist eine Sackgasse, die niemand
			// sieht: Die Task scheitert, und in der Meldung steht nur, dass
			// gepinnt wurde. Also steht dort jetzt auch, **warum** das nicht
			// aufgehen kann und was zu tun ist.
			const pinTot =
				profile.mode === "pinned" &&
				profile.pinnedProviderId &&
				!candidates.some((c) => c.instance.providerId === profile.pinnedProviderId)
					? ` · Der Rechner „${this.deps.registry.labelOf(profile.pinnedProviderId) ?? profile.pinnedProviderId}“ ` +
						"steht nicht zur Verfügung (deaktiviert oder offline). Pin am Spezialisten lösen oder den Rechner aktivieren."
					: ""
			const reason = `Keine Instanz verfügbar (${excluded.length} ausgeschlossen): ${summarizeExclusions(excluded)}${pinTot}`
			log("warn", "routing", `${reason} für Task ${task.id}`)
			// Sichtbares Scheitern: Execution-Record, damit die UI den Fehler zeigt und bewerten kann.
			const execution = createExecution(db, { taskId: task.id })
			const decision: RoutingDecision = {
				executionId: execution.id,
				chosenInstanceId: undefined,
				candidates: [],
				excluded,
				profile,
				weights: weights as unknown as Record<string, number>,
				createdAt: new Date().toISOString(),
			}
			saveDecision(db, decision)
			emit({ event: "routing.decided", data: { taskId: task.id, executionId: execution.id, decision } })
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
			.map((c) => scoreCandidate(c, profile, weights, feedback, task.prompt))
			.sort((a, b) => b.score - a.score)

		let ordered = this.orderByMode(scored, allowed, profile.mode)
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
				emit({ event: "routing.decided", data: { executionId: execution.id, taskId: task.id, decision } })
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
				// Ein Modell, das der Server nicht laden kann, ist nicht „gerade
				// unpässlich" — es ist bis auf Weiteres unbrauchbar. Ohne Sperre
				// wählt das Routing es beim nächsten Auftrag wieder (es hat ja den
				// besten Score) und scheitert erneut. Der Rechner selbst bleibt
				// unangetastet: Seine anderen Modelle laufen weiter.
				if (looksLikeLoadFailure(lastError)) {
					const fehler = recordLoadFailure(db, choice.instance.id)
					const dauer = lockDurationMs(fehler)
					const bis = new Date(Date.now() + dauer).toISOString()
					lockInstance(db, choice.instance.id, bis)
					log(
						"warn",
						"routing",
						`${choice.instance.modelId} lässt sich nicht laden (${fehler}. Mal) — für ${formatDauer(dauer)} gesperrt`,
					)
					// Ein Ladefehler heisst fast immer: Der Speicher ist belegt.
					// Für den nächsten Versuch zählt deshalb nicht mehr der beste
					// Score, sondern **was schon geladen ist** — ein Modell im
					// Speicher braucht keinen Ladevorgang und kann nicht daran
					// scheitern. Erst danach kommt der Rest in bisheriger Ordnung.
					ordered = this.preferLoaded(ordered, attempt + 1)
					// Und dem Rechner Zeit geben, sich zu fangen. Ohne diese Pause
					// scheitert der nächste Versuch am Nachhall des vorigen.
					const naechster = ordered[attempt + 1]
					if (naechster) {
						log(
							"info",
							"routing",
							`Rechner erholt sich — ${Math.round(MACHINE_COOLDOWN_MS / 1000)} s Pause vor ${naechster.instance.modelId}`,
						)
						await this.abkuehlen(MACHINE_COOLDOWN_MS, execution.id)
					}
				}
				// Was bis hierher entstand, bleibt erhalten. Ein Lauf, der nach 15
				// Minuten am Gesamt-Timeout stirbt, hat womöglich Dateien gelesen,
				// analysiert und halb geantwortet — das alles zu verwerfen und nur
				// „Timeout“ zu zeigen, macht die Arbeit wertlos.
				const partial = partialOutput(
					replayOutput(db, execution.id),
					this.reasoningByExecution.get(execution.id) ?? "",
				)
				updateExecution(db, execution.id, {
					status: "failed",
					error: lastError,
					finishedAt: new Date().toISOString(),
					...(partial ? { output: partial } : {}),
				})
				this.reasoningByExecution.delete(execution.id)
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

	/**
	 * Wohin schreibt diese Task? Mit gepinntem Repository sorgt der Aufrufer
	 * (siehe `index.ts`) dafür, dass dort ein Git-Worktree bereitsteht.
	 */
	private async taskDir(task: Task): Promise<string> {
		if (this.deps.resolveTaskDir) {
			return this.deps.resolveTaskDir(task)
		}
		return taskWorktreePath(this.deps.workspaceDir, task)
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
		const { db, emit, log, registry, feedback } = this.deps
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
		this.active.set(execution.id, {
			abort: controller,
			taskId: task.id,
			cancelled: false,
			providerId: choice.instance.providerId,
			modelId: choice.instance.modelId,
			// Welche Grafikkarte dieser Lauf belegt — nicht, über welchen
			// Endpunkt er dorthin kam.
			device: this.geraetSchluessel(choice.instance),
		})

		// Gesamt-Timeout + Chunk-Timeout (keine Aktivität → Failover).
		const limitsMs = this.timeouts(task.metadata.agentMode === true)
		const totalTimer = setTimeout(
			() => controller.abort(new Error(`Gesamt-Timeout nach ${Math.round(limitsMs.totalMs / 1000)} s`)),
			limitsMs.totalMs,
		)
		// Bis zum ersten Token gilt eine großzügige Frist (Modell laden + Prompt
		// verarbeiten), danach die strenge: Ein Stream, der mittendrin
		// verstummt, ist ein Fehler — ein Server, der lange nachdenkt, nicht.
		let firstChunkSeen = false
		const chunkDeadline = () => (firstChunkSeen ? limitsMs.chunkMs : limitsMs.firstChunkMs)
		const chunkTimeoutError = () =>
			firstChunkSeen
				? new Error(`Kein Chunk seit ${Math.round(limitsMs.chunkMs / 1000)} s`)
				: new Error(
						`Keine Antwort seit ${Math.round(limitsMs.firstChunkMs / 1000)} s — Modell zu langsam oder Server überlastet`,
					)
		let chunkTimer = setTimeout(() => controller.abort(chunkTimeoutError()), chunkDeadline())
		const resetChunkTimer = () => {
			firstChunkSeen = true
			clearTimeout(chunkTimer)
			chunkTimer = setTimeout(() => controller.abort(chunkTimeoutError()), chunkDeadline())
		}
		/**
		 * Ein neuer Agentik-Schritt ist ein **neuer** Aufruf: Das Modell bekommt
		 * den gesamten bisherigen Verlauf plus die gelesenen Dateien noch einmal
		 * und muss ihn erst durchrechnen. Bei 30 000 Token dauert allein das
		 * Minuten — die strenge Chunk-Frist (Standard 60 s) schlug dabei zu und
		 * verwarf eine halbe Stunde Arbeit. Deshalb gilt ab hier wieder die
		 * grosszügige Erst-Token-Frist, bis wirklich etwas ankommt.
		 */
		const relaxForNextStep = () => {
			firstChunkSeen = false
			clearTimeout(chunkTimer)
			chunkTimer = setTimeout(() => controller.abort(chunkTimeoutError()), chunkDeadline())
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
			const agentPlan = agent ? getAgentDoc(db, agent.id, "plan")?.content : undefined
			const systemPrompt = composeSystemPrompt([
				{
					label: `Rechner ${provider?.label ?? choice.instance.providerId}`,
					plan: getProviderDoc(db, choice.instance.providerId, "plan")?.content,
					systemPrompt: provider?.modelSettings?.systemPrompt,
				},
				{
					// Ein Modell bekommt keinen Auftrag — seine Eigenschaften
					// stehen im `llm.md` und wirken im Routing, nicht im Prompt.
					label: `Modell ${choice.instance.displayName}`,
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
				const baseDir = await this.taskDir(task)
				fs.mkdirSync(baseDir, { recursive: true })
				log("info", "agent", `Agentik-Modus aktiv für Task ${task.id} (${choice.instance.modelId})`)
				const result = await runAgentLoop({
					maxSteps: this.agentSettings().maxSteps,
					// Werkzeug-Freigabe des Modells (`llm.md` → `## Werkzeuge`).
					allowedTools: getInstanceSpec(db, choice.instance.id)?.tools,
					// Jeder Schritt beginnt mit einer neuen Prompt-Verarbeitung.
					onStepStart: relaxForNextStep,
					// Damit der Loop weiss, wann der Verlauf zu gross wird — und
					// zwar nach der **Wahrheit des Rechners**, nicht nach der
					// Fähigkeit des Modells. LM Studio meldet für dasselbe Modell
					// 262 144 als Maximum und lädt es mit 60 160; wer dem Maximum
					// glaubt, bekommt mitten in der Arbeit
					// „request (70017 tokens) exceeds the available context size".
					contextWindow: wirksamesFenster(choice.instance),
					// Was `run_command` starten darf — eine Entscheidung des Menschen.
					commandPolicy: this.commandPolicy(),
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
					onReasoning: (text) => {
						resetChunkTimer()
						this.appendReasoning(execution.id, text)
						emit({ event: "execution.reasoning", data: { executionId: execution.id, delta: text } })
					},
					emitToolCall: (data) => {
						resetChunkTimer()
						// Dauerhaft festhalten: Der SSE-Stream erreicht nur, wer gerade
						// zusieht. Nach einem Neuladen — oder im Verlauf von gestern —
						// wäre sonst nicht mehr erkennbar, welche Dateien das Modell
						// angefasst hat.
						appendToolCall(db, { executionId: execution.id, taskId: task.id, ...data })
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
					} else if (chunk.type === "reasoning") {
						// Denk-Tokens halten den Stream am Leben und werden live gezeigt,
						// landen aber nicht in der Antwort.
						resetChunkTimer()
						this.appendReasoning(execution.id, chunk.text)
						emit({
							event: "execution.reasoning",
							data: { executionId: execution.id, delta: chunk.text },
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

		// Reasoning-Modelle können den gesamten Lauf im Gedankengang verbringen
		// und keine einzige Zeile Antwort liefern. Eine leere Antwort bei
		// tausenden verbrauchten Tokens ist für niemanden brauchbar — dann gilt
		// der Gedankengang als Ergebnis, ausdrücklich gekennzeichnet.
		const reasoningText = this.reasoningByExecution.get(execution.id) ?? ""
		this.reasoningByExecution.delete(execution.id)
		if (fullText.trim().length === 0 && reasoningText.trim().length > 0) {
			fullText = `[Nur Gedankengang — das Modell hat keine eigentliche Antwort ausgegeben.]\n\n${reasoningText}`
			appendChunk(db, execution.id, seq++, fullText)
			log(
				"warn",
				"engine",
				`Execution ${execution.id}: keine Antwort, nur Gedankengang (${reasoningText.length} Zeichen) — Modell ${choice.instance.modelId}`,
			)
		}

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
				const written = writeWorkspaceFilesAt(await this.taskDir(task), blocks)
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
		// Das Modell hat geliefert — frühere Ladefehler waren also Momentaufnahmen
		// und sollen die nächste Sperre nicht verlängern.
		clearLoadFailures(db, choice.instance.id)
		await this.autoCommit(task)
		this.startNextChainStep(task, fullText)
		// Kapazität ist frei geworden — wartende Kettenschritte nachziehen.
		this.drainQueued()
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
