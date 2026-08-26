/**
 * Task- & Execution-Typen (`01-plan.md` §7, §11).
 */

import type { AssignmentMode } from "./agents.js"
import type { TaskProfile } from "./routing.js"
import type { ModelSettings, PrivacyMode, ProviderStatus, RoutingMode } from "./types.js"

export type TaskStatus = "draft" | "routing" | "queued" | "running" | "done" | "failed" | "cancelled"

export type ExecutionStatus = "pending" | "running" | "done" | "failed" | "cancelled"

export interface TaskMetadata {
	/** Freier Text: was soll das Ergebnis sein? */
	goal?: string
	/** Zielsprache des Outputs (z. B. "deutsch"). */
	language?: string
	constraints?: string
	privacy: PrivacyMode
	budgetUsd?: number
	mode: RoutingMode
	/** Pinned-Modus: konkrete Instanz statt Routing. */
	preferredProviderId?: string
	preferredModelId?: string
	/** M8 Agentik: Modell darf Datei-Tools (read/write/list) in der Sandbox nutzen. */
	agentMode?: boolean
	/**
	 * Gesprächs-ID der Chat-Ansicht. Jede Chat-Nachricht ist eine gewöhnliche
	 * Task; diese ID fasst sie zu einem Gespräch zusammen. Damit ist der
	 * Verlauf die Datenbank selbst — nichts wird im Browser dupliziert.
	 */
	chatId?: string
	/**
	 * A/B-Vergleich (T1-1): Gemeinsame Kennung aller Mitglieder eines
	 * Modell-Duells. Jede Task ist eine normale Task mit eigener
	 * Pinned-Instanz; diese ID bindet sie zusammen, damit die Oberfläche
	 * die Spalten nebeneinander zeigen kann.
	 */
	compareId?: string
	/**
	 * T1-4 Scheduling: Kennung des Zeitplans, aus dem diese Task stammt.
	 * Damit bleiben geplante Läufe im Dashboard als "Planlauf" erkennbar,
	 * ohne eine eigene Task-Tabelle zu brauchen.
	 */
	scheduleId?: string
	/** Titel des Zeitplans — für die Anzeige ohne zweiten Lookup. */
	scheduleTitle?: string
	/**
	 * Kette von Spezialisten für **einen** Auftrag.
	 *
	 * Manche Aufträge brauchen mehrere Rollen nacheinander — klären, bauen,
	 * prüfen. Jeder Schritt ist eine eigene Task mit eigenem Spezialisten und
	 * eigener Ausführung; `index` sagt, an welcher Stelle diese Task steht.
	 * Läuft ein Schritt erfolgreich durch, startet der Core den nächsten.
	 */
	/**
	 * `fast` = Schnellmodus: ein Spezialist statt Schwarm, und die Auswahl
	 * gewichtet gemessenes Tempo dreifach. Für kleine Korrekturen, bei denen
	 * eine gründliche Kette mehr Zeit kostet, als die Aufgabe wert ist.
	 */
	speed?: "fast" | "normal"
	chain?: {
		/** Alle Beteiligten in Reihenfolge — für Anzeige und Rückwärtskompatibilität. */
		agentIds: string[]
		/** Position dieser Task in `agentIds` (Altbestand; heute abgeleitet). */
		index: number
		goal?: string
		/** Gemeinsame Kennung aller Schritte einer Kette — bindet die Stufen zusammen. */
		id?: string
		/**
		 * Die Task, die die Kette eröffnet hat. Alle Schritte arbeiten in **ihrem**
		 * Verzeichnis und auf **ihrem** Branch: Sonst begänne jeder Schritt in
		 * einem leeren Ordner, müsste das Projekt erneut lesen und verlöre die
		 * Änderungen des vorigen — bei vier Spezialisten viermal dieselbe Arbeit.
		 */
		rootTaskId?: string
		/**
		 * Die Stufen der Kette: Innerhalb einer Stufe arbeiten alle Spezialisten
		 * **gleichzeitig** (auf allen verfügbaren Rechnern), die nächste Stufe
		 * beginnt erst, wenn die vorige vollständig fertig ist.
		 */
		stages?: string[][]
		/** Stufe, zu der diese Task gehört. */
		stage?: number
	}
}

export interface Task {
	id: string
	title: string
	prompt: string
	metadata: TaskMetadata
	status: TaskStatus
	createdAt: string
	finishedAt?: string
	/** Zuordnung: `auto` (Prompt-Match), `agent` (fester Spezialist), `swarm`. */
	assignmentMode?: AssignmentMode
	/** Gewählter Spezialist (bei `auto`: Ergebnis der Auto-Zuordnung). */
	agentId?: string
	/** Swarm für den `swarm`-Modus. */
	swarmId?: string
	/** Task-Override für Model-Settings — höchste Priorität. */
	overrides?: ModelSettings
	/** GitHub-Anbindung (M10): an welches Repository ist die Task gepinnt? */
	repoId?: string | null
	/** Basis-Branch, von dem der Arbeitsbranch abzweigt. */
	baseBranch?: string | null
	/** Arbeitsbranch dieser Task (`diriz/<slug>`). */
	workBranch?: string | null
	/** Zeitpunkt des letzten Pushes. */
	pushedAt?: string | null
	/** Link zum Pull-Request, sofern geöffnet. */
	prUrl?: string | null
}

export interface Execution {
	id: string
	taskId: string
	instanceId?: string
	providerId?: string
	status: ExecutionStatus
	startedAt?: string
	finishedAt?: string
	tokensIn?: number
	tokensOut?: number
	tpsAvg?: number
	costUsd?: number
	error?: string
	failoverCount: number
	rating?: number
	ratingComment?: string
	/** Vollständiger Output (für Replay; große Executions werden verdichtet). */
	output?: string
	files?: { relPath: string; size: number }[]
}

/** Ein Mitglied eines A/B-Vergleichs (T1-1) — eine Task samt ihrem Lauf. */
export interface CompareMember {
	taskId: string
	instanceId?: string
	providerId?: string
	modelName: string
	providerLabel?: string
	status: TaskStatus
	output: string
	error?: string
	tokensIn?: number
	tokensOut?: number
	tpsAvg?: number
	costUsd?: number
	durationMs?: number
}

/** Ergebnisansicht eines A/B-Vergleichs (T1-1). */
export interface CompareResult {
	compareId: string
	prompt: string
	createdAt: string
	members: CompareMember[]
	allFinished: boolean
}

export interface TaskWithExecutions extends Task {
	executions: Execution[]
}

/** Ein gespeicherter Routing-Kandidat mit vollständiger Aufschlüsselung. */
export interface CandidateScore {
	instanceId: string
	providerId: string
	modelId: string
	/** 0–100; -1 bei Ausschluss. */
	score: number
	axes: { key: string; label: string; value: number; weight: number; weighted: number }[]
}

export interface ExcludedInstance {
	instanceId: string
	providerId: string
	modelId: string
	reason: string
}

/** Persistierte Routing-Entscheidung — die Explainability-Basis (§6.4). */
export interface RoutingDecision {
	executionId: string
	chosenInstanceId?: string
	candidates: CandidateScore[]
	excluded: ExcludedInstance[]
	profile: TaskProfile
	weights: Record<string, number>
	createdAt: string
}

export interface InstanceRef {
	instanceId: string
	providerId: string
	modelId: string
	displayName: string
	status: ProviderStatus
}

/** Wiederverwendbare System-Prompt-Vorlage (M2/Q4, z. B. „Senior-Dev“). */
export interface PromptTemplate {
	id: string
	name: string
	prompt: string
	createdAt: string
}

/**
 * Routing-Preview / Dry-Run (M3): Zeigt vor der Ausführung, welche Instanz
 * gewählt würde — exakt dieselbe Pipeline wie `runTask` (Profil → Policies →
 * Scoring), aber ohne Execution, Persistenz oder Failover.
 */
export interface RoutePreview {
	taskId: string
	assignmentMode: AssignmentMode
	agentId?: string
	agentName?: string
	/** Begründung der Agenten-Zuordnung (bzw. Fehler bei ungültiger Konfiguration). */
	agentReason?: string
	decision: RoutingDecision
	createdAt: string
}
