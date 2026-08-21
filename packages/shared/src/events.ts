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
	data: { executionId: string; decision: RoutingDecision }
}

export interface ExecutionDeltaEvent {
	event: "execution.delta"
	data: { executionId: string; delta: string; tokens: number }
}

export interface ExecutionUsageEvent {
	event: "execution.usage"
	data: { executionId: string; tokensIn: number; tokensOut: number; tps: number; costUsd: number }
}

export interface ExecutionFailoverEvent {
	event: "execution.failover"
	data: { executionId: string; from: string; to: string; reason: string }
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

export type CoreEvent =
	| TaskCreatedEvent
	| AgentSelectedEvent
	| AgentsChangedEvent
	| SwarmsChangedEvent
	| RoutingDecidedEvent
	| ExecutionDeltaEvent
	| ExecutionUsageEvent
	| ExecutionFailoverEvent
	| ExecutionDoneEvent
	| ExecutionFailedEvent
	| ProviderStatusEvent
	| LogEvent

/** Sämtliche Event-Namen — für Client-Validierung und Tests. */
export const CORE_EVENT_NAMES = [
	"task.created",
	"task.agent_selected",
	"agents.changed",
	"swarms.changed",
	"routing.decided",
	"execution.delta",
	"execution.usage",
	"execution.failover",
	"execution.done",
	"execution.failed",
	"provider.status",
	"log",
] as const
