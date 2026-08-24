import type { ComponentType } from "react"
import { useEffect, useState } from "react"
import ErrorBoundary from "./components/ErrorBoundary.js"
import type { IconProps } from "./components/icons.js"
import {
	IconAgents,
	IconChat,
	IconDashboard,
	IconDoc,
	IconGitBranch,
	IconLogs,
	IconMenu,
	IconServer,
	IconSettings,
	IconTasks,
	IconWorkspace,
	LogoMark,
} from "./components/icons.js"
import Onboarding, { shouldShowOnboarding } from "./components/Onboarding.js"
import Toasts from "./components/Toasts.js"
import { ROUTE_TITLES, type Route, useRoute } from "./lib/router.js"
import { connectStream } from "./lib/sse.js"
import { useStore } from "./store.js"
import Agents from "./views/Agents.js"
import Chat from "./views/Chat.js"
import Dashboard from "./views/Dashboard.js"
import Docs from "./views/Docs.js"
import Github from "./views/Github.js"
import Logs from "./views/Logs.js"
import Providers from "./views/Providers.js"
import Settings from "./views/Settings.js"
import Tasks from "./views/Tasks.js"
import Workspace from "./views/Workspace.js"

interface NavItem {
	id: Route
	label: string
	icon: ComponentType<IconProps>
}

/** Navigation in fachliche Gruppen geteilt — Überblick, Konfiguration, Betrieb. */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
	{
		title: "Überblick",
		items: [
			{ id: "dashboard", label: "Dashboard", icon: IconDashboard },
			{ id: "chat", label: "Chat", icon: IconChat },
		],
	},
	{
		title: "Orchestrierung",
		items: [
			{ id: "providers", label: "Provider", icon: IconServer },
			{ id: "agents", label: "Agenten", icon: IconAgents },
			{ id: "tasks", label: "Tasks", icon: IconTasks },
			{ id: "docs", label: "Dokumente", icon: IconDoc },
			{ id: "github", label: "GitHub", icon: IconGitBranch },
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
	const { route, navigate } = useRoute()
	const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding)
	/** Sidebar auf schmalen Bildschirmen — auf Desktop immer sichtbar. */
	const [navOpen, setNavOpen] = useState(false)
	const connected = useStore((s) => s.connected)
	const metrics = useStore((s) => s.metrics)
	const tasks = useStore((s) => s.tasks)
	const setConnected = useStore((s) => s.setConnected)
	const handleStreamEvent = useStore((s) => s.handleStreamEvent)
	const version = useStore((s) => s.version)

	useEffect(() => {
		const state = useStore.getState()
		void state.refreshProviders()
		void state.refreshAgents()
		void state.refreshSwarms()
		void state.refreshTasks()
		void state.refreshMetrics()
		void state.refreshSettings()
		void state.refreshVersion()
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
	const counts: Partial<Record<Route, number>> = { tasks: runningTasks }

	const go = (to: Route) => {
		navigate(to)
		setNavOpen(false)
	}

	return (
		<div className={`app ${navOpen ? "nav-open" : ""}`}>
			<a href="#main" className="skip-link">
				Zum Inhalt springen
			</a>

			<aside className="sidebar" id="nav">
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
									className={`nav-btn ${route === item.id ? "active" : ""}`}
									aria-label={item.label}
									title={item.label}
									aria-current={route === item.id ? "page" : undefined}
									onClick={() => go(item.id)}
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

			{navOpen && (
				<button
					type="button"
					className="nav-scrim"
					aria-label="Navigation schließen"
					onClick={() => setNavOpen(false)}
				/>
			)}

			<main className="main" id="main">
				<button
					type="button"
					className="nav-toggle"
					aria-label="Navigation öffnen"
					aria-expanded={navOpen}
					aria-controls="nav"
					onClick={() => setNavOpen((v) => !v)}
				>
					<IconMenu size={18} />
					<span>{ROUTE_TITLES[route]}</span>
				</button>

				{/* Ein Fehler in einer Ansicht darf nie die ganze App abräumen. */}
				<ErrorBoundary resetKey={route}>
					{route === "dashboard" && <Dashboard />}
					{route === "chat" && <Chat />}
					{route === "providers" && <Providers />}
					{route === "agents" && <Agents />}
					{route === "tasks" && <Tasks />}
					{route === "docs" && <Docs />}
					{route === "github" && <Github />}
					{route === "workspace" && <Workspace />}
					{route === "logs" && <Logs />}
					{route === "settings" && <Settings />}
				</ErrorBoundary>
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
					<span className="faint" title={version ? `Schema v${version.schemaVersion}` : undefined}>
						DiriZ {version ? `v${version.version}` : "…"}
					</span>
				</span>
			</footer>

			<Toasts />
			{showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
		</div>
	)
}
