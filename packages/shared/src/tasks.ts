/**
 * Task- & Execution-Typen (`01-plan.md` §7, §11).
 */

import type { Capability, PrivacyMode, ProviderStatus, RoutingMode } from "./types.js"

export type TaskStatus =
	| "draft"
	| "routing"
	| "queued"
	| "running"
	| "done"
	| "failed"
	| "cancelled"

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
}

export interface Task {
	id: string
	title: string
	prompt: string
	metadata: TaskMetadata
	status: TaskStatus
	createdAt: string
	finishedAt?: string
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
