/**
 * Zentraler Zustand (Zustand): Provider, Tasks, Logs, Metriken,
 * Live-Executions. SSE-Events aktualisieren den Store direkt.
 */

import type {
	Agent,
	CoreEvent,
	Execution,
	LogEvent,
	Provider,
	RoutingDecision,
	ScoringWeights,
	Swarm,
	Task,
} from "@diriz/shared"
import { create } from "zustand"
import { api } from "./lib/api.js"
import type { StreamEvent } from "./lib/sse.js"

export interface LogLine {
	ts: string
	level: string
	scope: string
	msg: string
}

export interface LiveRun {
	text: string
	status: "running" | "done" | "failed"
	usage?: { tokensIn: number; tokensOut: number; tps: number; costUsd: number }
	failovers: string[]
}

export interface TaskDetail {
	executions: Execution[]
	files: { relPath: string; size: number }[]
	decisions: RoutingDecision[]
	running?: boolean
	agentSelection?: {
		taskId: string
		mode: string
		agentId: string | null
		agentName?: string
		reason?: string
		candidates: { agentId: string; name: string; score: number; reasons: string[] }[]
		createdAt: string
	}
	agent?: Agent
}

export interface ProviderView extends Provider {
	instanceCount?: number
}

export interface MetricsView {
	providers: number
	onlineProviders: number
	instances: number
	tasks: number
	executions: number
	activeExecutions: number
	tokensIn24h: number
	tokensOut24h: number
	costUsd24h: number
	vramTotal?: number
	vramUsed?: number
	schemaVersion: number
}

interface State {
	connected: boolean
	providers: ProviderView[]
	agents: Agent[]
	swarms: Swarm[]
	tasks: (Task & { running?: boolean })[]
	logs: LogLine[]
	metrics: MetricsView | null
	timeseries: { bucket: string; requests: number; tokens: number; costUsd: number; errors: number }[]
	settings: { routingWeights: ScoringWeights } | null
	live: Record<string, LiveRun>
	taskDetails: Record<string, TaskDetail>
	lastError?: string

	setConnected(connected: boolean): void
	setLastError(message?: string): void
	refreshProviders(): Promise<void>
	refreshAgents(): Promise<void>
	refreshSwarms(): Promise<void>
	refreshTasks(): Promise<void>
	refreshLogs(): Promise<void>
	refreshMetrics(): Promise<void>
	refreshSettings(): Promise<void>
	saveSettings(weights: ScoringWeights): Promise<boolean>
	loadTaskDetail(taskId: string): Promise<void>
	handleStreamEvent(event: StreamEvent): void
}

const MAX_LOGS = 500

export const useStore = create<State>((set, get) => ({
	connected: false,
	providers: [],
	agents: [],
	swarms: [],
	tasks: [],
	logs: [],
	metrics: null,
	timeseries: [],
	settings: null,
	live: {},
	taskDetails: {},
	lastError: undefined,

	setConnected: (connected) => set({ connected }),
	setLastError: (message) => set({ lastError: message }),

	refreshProviders: async () => {
		try {
			const providers = await api.get<ProviderView[]>("/api/providers")
			set({ providers })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	refreshAgents: async () => {
		try {
			const agents = await api.get<Agent[]>("/api/agents")
			set({ agents })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	refreshSwarms: async () => {
		try {
			const swarms = await api.get<Swarm[]>("/api/swarms")
			set({ swarms })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	refreshTasks: async () => {
		try {
			const tasks = await api.get<(Task & { running?: boolean })[]>("/api/tasks")
			set({ tasks })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	refreshLogs: async () => {
		try {
			const logs = await api.get<LogLine[]>("/api/logs?limit=200")
			set({ logs })
		} catch {
			// Logs sind nicht kritisch.
		}
	},

	refreshMetrics: async () => {
		try {
			const [metrics, timeseries] = await Promise.all([
				api.get<MetricsView>("/api/metrics"),
				api.get<State["timeseries"]>("/api/metrics/timeseries?hours=24"),
			])
			set({ metrics, timeseries })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	refreshSettings: async () => {
		try {
			const settings = await api.get<State["settings"]>("/api/settings")
			set({ settings })
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	saveSettings: async (weights) => {
		try {
			const saved = await api.put<State["settings"]>("/api/settings", { routingWeights: weights })
			set({ settings: saved, lastError: undefined })
			return true
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
			return false
		}
	},

	loadTaskDetail: async (taskId) => {
		try {
			const detail = await api.get<TaskDetail>(`/api/tasks/${taskId}`)
			set((s) => ({ taskDetails: { ...s.taskDetails, [taskId]: detail } }))
		} catch (e) {
			set({ lastError: e instanceof Error ? e.message : String(e) })
		}
	},

	handleStreamEvent: (event) => {
		const state = get()
		const core = event as unknown as CoreEvent
		switch (core.event) {
			case "task.created":
				void state.refreshTasks()
				break
			case "task.agent_selected": {
				const taskId = (core as { data: { taskId?: string } }).data?.taskId
				void state.refreshTasks()
				if (taskId && state.taskDetails[taskId]) {
					void state.loadTaskDetail(taskId)
				}
				break
			}
			case "agents.changed":
				void state.refreshAgents()
				break
			case "swarms.changed":
				void state.refreshSwarms()
				break
			case "routing.decided": {
				const { executionId } = core.data
				set((s) => ({
					live: {
						...s.live,
						[executionId]: { text: "", status: "running", failovers: [] },
					},
				}))
				break
			}
			case "execution.delta": {
				const { executionId, delta } = core.data
				set((s) => {
					const run = s.live[executionId] ?? { text: "", status: "running" as const, failovers: [] }
					return { live: { ...s.live, [executionId]: { ...run, text: run.text + delta } } }
				})
				break
			}
			case "execution.usage": {
				const { executionId, ...usage } = core.data
				set((s) => {
					const run = s.live[executionId]
					return run ? { live: { ...s.live, [executionId]: { ...run, usage } } } : s
				})
				break
			}
			case "execution.failover": {
				const { executionId, from, to, reason } = core.data
				set((s) => {
					const run = s.live[executionId] ?? { text: "", status: "running" as const, failovers: [] }
					return {
						live: {
							...s.live,
							[executionId]: { ...run, failovers: [...run.failovers, `${from} → ${to} (${reason})`] },
						},
					}
				})
				break
			}
			case "execution.done":
			case "execution.failed": {
				const { executionId, taskId } = core.data
				const done = core.event === "execution.done"
				set((s) => {
					const run = s.live[executionId]
					return {
						live: run ? { ...s.live, [executionId]: { ...run, status: done ? "done" : "failed" } } : s.live,
					}
				})
				void state.refreshTasks()
				void state.loadTaskDetail(taskId)
				break
			}
			case "provider.status":
				void state.refreshProviders()
				break
			case "log": {
				const log = core as LogEvent
				set((s) => {
					const next: LogLine = {
						ts: new Date().toISOString(),
						level: log.data.level,
						scope: log.data.scope,
						msg: log.data.msg,
					}
					const logs = [...s.logs, next]
					return { logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs }
				})
				break
			}
			default:
				break
		}
	},
}))
