import { useEffect, useState } from "react"
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

const NAV: { id: View; label: string }[] = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "providers", label: "Provider" },
	{ id: "agents", label: "Agenten" },
	{ id: "tasks", label: "Tasks" },
	{ id: "workspace", label: "Workspace" },
	{ id: "logs", label: "Logs" },
	{ id: "settings", label: "Einstellungen" },
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

	return (
		<div className="app">
			<aside className="sidebar">
				<div className="brand">
					Diri<span>Z</span>
				</div>
				{NAV.map((item) => (
					<button
						key={item.id}
						type="button"
						className={`nav-btn ${view === item.id ? "active" : ""}`}
						onClick={() => setView(item.id)}
					>
						{item.label}
					</button>
				))}
				<div style={{ marginTop: "auto", padding: "8px", fontSize: 12 }} className="row">
					<span className={`dot ${connected ? "online" : "offline"}`} />
					<span className="muted">{connected ? "verbunden" : "getrennt"}</span>
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
				<span className="muted">·</span>
				<span>{metrics?.activeExecutions ?? 0} aktiv</span>
				{runningTasks > 0 && (
					<>
						<span className="muted">·</span>
						<span style={{ color: "var(--accent)" }}>{runningTasks} Task(s) laufen</span>
					</>
				)}
				<span className="muted" style={{ marginLeft: "auto" }}>
					{metrics?.onlineProviders ?? 0}/{metrics?.providers ?? 0} Provider online · DiriZ v1.0
				</span>
			</footer>

			{showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
		</div>
	)
}
