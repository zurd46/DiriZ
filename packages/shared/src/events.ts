/**
 * SSE-Event-Kontrakte (`01-plan.md` §7.3).
 *
 * Der Core emittiert diese Events auf `GET /api/stream`. Der UI-Client
 * (Zustand-Store) und spätere Clients (Desktop, mobile) hängen sich daran.
 */

import type { AgentScore, AssignmentMode } from "./agents.js"
import type { RoutingDecision } from "./tasks.js"
import type { ProviderStatus } from "./types.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface TaskCreatedEvent {
	event: "task.created"
	data: { taskId: string }
}

export interface AgentSelectedEvent {
	event: "task.agent_selected"
	data: {
		taskId: string
		agentId?: string | null
		agentName?: string
		mode: AssignmentMode
		reason?: string
		candidates: AgentScore[]
	}
}

export interface AgentsChangedEvent {
	event: "agents.changed"
	data: { agentId?: string }
}

export interface SwarmsChangedEvent {
	event: "swarms.changed"
	data: { swarmId?: string }
}

export interface RoutingDecidedEvent {
	event: "routing.decided"
	/** `taskId` ordnet den Live-Stream seiner Task zu (Chat-Ansicht, Monitor). */
	data: { executionId: string; taskId: string; decision: RoutingDecision }
}

export interface ExecutionDeltaEvent {
	event: "execution.delta"
	data: { executionId: string; delta: string; tokens: number }
}

/** Gedankengang eines Reasoning-Modells — live, aber getrennt von der Antwort. */
export interface ExecutionReasoningEvent {
	event: "execution.reasoning"
	data: { executionId: string; delta: string }
}

export interface ExecutionUsageEvent {
	event: "execution.usage"
	data: { executionId: string; tokensIn: number; tokensOut: number; tps: number; costUsd: number }
}

export interface ExecutionFailoverEvent {
	event: "execution.failover"
	data: { executionId: string; from: string; to: string; reason: string }
}

/** M8 Agentik: eine Tool-Operation des Modells — volle Transparenz im Monitor. */
export interface ToolCallEvent {
	event: "tool.call"
	data: {
		executionId: string
		name: string
		argsSummary: string
		ok: boolean
		detail?: string
	}
}

export interface ExecutionDoneEvent {
	event: "execution.done"
	data: { executionId: string; taskId: string }
}

export interface ExecutionFailedEvent {
	event: "execution.failed"
	data: { executionId: string; taskId: string; error: string }
}

export interface ProviderStatusEvent {
	event: "provider.status"
	data: { providerId: string; status: ProviderStatus }
}

export interface LogEvent {
	event: "log"
	data: { level: LogLevel; scope: string; msg: string }
}

/** Eine Task wurde nach GitHub gepusht (M10). */
export interface TaskPushedEvent {
	event: "task.pushed"
	data: { taskId: string; branch: string; toBase: boolean }
}

export type CoreEvent =
	| TaskCreatedEvent
	| TaskPushedEvent
	| AgentSelectedEvent
	| AgentsChangedEvent
	| SwarmsChangedEvent
	| RoutingDecidedEvent
	| ExecutionDeltaEvent
	| ExecutionReasoningEvent
	| ExecutionUsageEvent
	| ExecutionFailoverEvent
	| ToolCallEvent
	| ExecutionDoneEvent
	| ExecutionFailedEvent
	| ProviderStatusEvent
	| LogEvent

/** Sämtliche Event-Namen — für Client-Validierung und Tests. */
export const CORE_EVENT_NAMES = [
	"task.created",
	"task.pushed",
	"task.agent_selected",
	"agents.changed",
	"swarms.changed",
	"routing.decided",
	"execution.delta",
	"execution.reasoning",
	"execution.usage",
	"execution.failover",
	"tool.call",
	"execution.done",
	"execution.failed",
	"provider.status",
	"log",
] as const
