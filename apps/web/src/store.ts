/**
 * Zentraler Zustand (Zustand): Provider, Tasks, Logs, Metriken,
 * Live-Executions. SSE-Events aktualisieren den Store direkt.
 */

import type { CoreEvent, Execution, LogEvent, Provider, RoutingDecision, Task } from "@diriz/shared"
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
	schemaVersion: number
}

interface State {
	connected: boolean
	providers: ProviderView[]
	tasks: (Task & { running?: boolean })[]
	logs: LogLine[]
	metrics: MetricsView | null
	timeseries: { bucket: string; requests: number; tokens: number; costUsd: number; errors: number }[]
	live: Record<string, LiveRun>
	taskDetails: Record<string, TaskDetail>
	lastError?: string

	setConnected(connected: boolean): void
	setLastError(message?: string): void
	refreshProviders(): Promise<void>
	refreshTasks(): Promise<void>
	refreshLogs(): Promise<void>
	refreshMetrics(): Promise<void>
	loadTaskDetail(taskId: string): Promise<void>
	handleStreamEvent(event: StreamEvent): void
}

const MAX_LOGS = 500

export const useStore = create<State>((set, get) => ({
	connected: false,
	providers: [],
	tasks: [],
	logs: [],
	metrics: null,
	timeseries: [],
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
