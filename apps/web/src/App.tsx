import type { ComponentType } from "react"
import { useEffect, useState } from "react"
import type { IconProps } from "./components/icons.js"
import {
	IconAgents,
	IconDashboard,
	IconLogs,
	IconServer,
	IconSettings,
	IconTasks,
	IconWorkspace,
	LogoMark,
} from "./components/icons.js"
import Onboarding, { shouldShowOnboarding } from "./components/Onboarding.js"
import { connectStream } from "./lib/sse.js"
import { useStore } from "./store.js"
import Agents from "./views/Agents.js"
import Dashboard from "./views/Dashboard.js"
import Logs from "./views/Logs.js"
import Providers from "./views/Providers.js"
import Settings from "./views/Settings.js"
import Tasks from "./views/Tasks.js"
import Workspace from "./views/Workspace.js"

type View = "dashboard" | "providers" | "agents" | "tasks" | "logs" | "workspace" | "settings"

interface NavItem {
	id: View
	label: string
	icon: ComponentType<IconProps>
}

/** Navigation in fachliche Gruppen geteilt — Überblick, Konfiguration, Betrieb. */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
	{
		title: "Überblick",
		items: [{ id: "dashboard", label: "Dashboard", icon: IconDashboard }],
	},
	{
		title: "Orchestrierung",
		items: [
			{ id: "providers", label: "Provider", icon: IconServer },
			{ id: "agents", label: "Agenten", icon: IconAgents },
			{ id: "tasks", label: "Tasks", icon: IconTasks },
		],
	},
	{
		title: "Betrieb",
		items: [
			{ id: "workspace", label: "Workspace", icon: IconWorkspace },
			{ id: "logs", label: "Logs", icon: IconLogs },
			{ id: "settings", label: "Einstellungen", icon: IconSettings },
		],
	},
]

export default function App() {
	const [view, setView] = useState<View>("dashboard")
	const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding)
	const connected = useStore((s) => s.connected)
	const metrics = useStore((s) => s.metrics)
	const tasks = useStore((s) => s.tasks)
	const setConnected = useStore((s) => s.setConnected)
	const handleStreamEvent = useStore((s) => s.handleStreamEvent)

	useEffect(() => {
		const state = useStore.getState()
		void state.refreshProviders()
		void state.refreshAgents()
		void state.refreshSwarms()
		void state.refreshTasks()
		void state.refreshMetrics()
		void state.refreshSettings()
		const handle = connectStream(handleStreamEvent, setConnected)
		const metricsTimer = setInterval(() => useStore.getState().refreshMetrics(), 15_000)
		const logsTimer = setInterval(() => useStore.getState().refreshLogs(), 10_000)
		return () => {
			handle.close()
			clearInterval(metricsTimer)
			clearInterval(logsTimer)
		}
	}, [handleStreamEvent, setConnected])

	const runningTasks = tasks.filter((t) => t.running).length
	const counts: Partial<Record<View, number>> = { tasks: runningTasks }

	return (
		<div className="app">
			<aside className="sidebar">
				<div className="brand">
					<LogoMark size={30} />
					<span className="brand-text">
						<span>
							Diri<span>Z</span>
						</span>
						<span className="brand-sub">Control Tower</span>
					</span>
				</div>

				{NAV_GROUPS.map((group) => (
					<div key={group.title}>
						<div className="nav-group">{group.title}</div>
						{group.items.map((item) => {
							const Icon = item.icon
							const count = counts[item.id]
							return (
								<button
									key={item.id}
									type="button"
									className={`nav-btn ${view === item.id ? "active" : ""}`}
									aria-current={view === item.id ? "page" : undefined}
									onClick={() => setView(item.id)}
								>
									<Icon size={17} />
									<span>{item.label}</span>
									{count !== undefined && count > 0 && <span className="nav-count live">{count}</span>}
								</button>
							)
						})}
					</div>
				))}

				<div className="sidebar-foot">
					<span className={`dot ${connected ? "online" : "offline"}`} />
					<span>{connected ? "verbunden" : "getrennt"}</span>
				</div>
			</aside>

			<main className="main">
				{view === "dashboard" && <Dashboard />}
				{view === "providers" && <Providers />}
				{view === "agents" && <Agents />}
				{view === "tasks" && <Tasks />}
				{view === "workspace" && <Workspace />}
				{view === "logs" && <Logs />}
				{view === "settings" && <Settings />}
			</main>

			<footer className="statusbar">
				<span className={`dot ${connected ? "online" : "offline"}`} />
				<span>{connected ? "verbunden" : "getrennt"}</span>
				<span className="sep">·</span>
				<span>
					<strong>{metrics?.activeExecutions ?? 0}</strong> aktiv
				</span>
				{runningTasks > 0 && (
					<>
						<span className="sep">·</span>
						<span style={{ color: "var(--accent)" }}>
							<strong style={{ color: "inherit" }}>{runningTasks}</strong>{" "}
							{runningTasks === 1 ? "Task läuft" : "Tasks laufen"}
						</span>
					</>
				)}
				<span style={{ marginLeft: "auto" }} className="row tight">
					<span>
						<strong>
							{metrics?.onlineProviders ?? 0}/{metrics?.providers ?? 0}
						</strong>{" "}
						Provider online
					</span>
					<span className="sep">·</span>
					<span className="faint">DiriZ v1.0</span>
				</span>
			</footer>

			{showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
		</div>
	)
}
