/**
 * Chat — der einfache Einstieg: Aufgabe beschreiben, das System sucht den
 * passenden Spezialisten und arbeitet.
 *
 * Die Ansicht ist bewusst dünn: Sie legt pro Nachricht eine ganz normale Task
 * an (`assignmentMode: "auto"`), startet sie und zeigt den Live-Stream. Alles
 * Weitere — Spezialisten-Zuordnung, Routing, Failover, Dateien — macht die
 * Engine. Damit gibt es keinen zweiten Ausführungsweg, der auseinanderdriften
 * könnte; jede Chat-Nachricht ist unter „Tasks“ vollständig nachvollziehbar.
 *
 * Das Ziel entscheidet, was der Spezialist anfassen darf:
 * - **Antwort**: nur Text, kein Dateizugriff.
 * - **Projekt anlegen**: Agentik-Modus im Workspace — er darf Dateien schreiben.
 * - **Repository ändern**: Agentik-Modus in einem Git-Worktree des Repos.
 */

import type { Repo, Task } from "@diriz/shared"
import { useEffect, useRef, useState } from "react"
import {
	IconAgents,
	IconChat,
	IconDoc,
	IconGitBranch,
	IconPlay,
	IconStop,
	IconTrash,
	IconWorkspace,
} from "../components/icons.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

/** Wo die Arbeit stattfindet — bestimmt Werkzeuge und Arbeitsverzeichnis. */
type Target = "answer" | "workspace" | "repo"

const TARGETS: { id: Target; label: string; hint: string }[] = [
	{ id: "answer", label: "Nur antworten", hint: "Text ohne Dateizugriff — Fragen, Konzepte, Reviews" },
	{ id: "workspace", label: "Projekt anlegen", hint: "Darf Dateien im Workspace schreiben" },
	{
		id: "repo",
		label: "Repository ändern",
		hint: "Arbeitet im Git-Worktree eines verbundenen Repos — dafür muss es unter „GitHub“ angebunden sein (Token allein genügt nicht)",
	},
]

interface Turn {
	id: string
	prompt: string
	target: Target
	repoLabel?: string
	taskId?: string
	status: "sending" | "running" | "done" | "failed"
	error?: string
}

/** Titel aus der ersten Zeile — er benennt später auch den Git-Branch. */
function titleFrom(prompt: string): string {
	const first = prompt.trim().split(/\r?\n/)[0] ?? ""
	return first.length > 70 ? `${first.slice(0, 67)}…` : first || "Chat"
}

/** Gekürzter Verlauf als Vorspann — sonst beantwortet jede Task nur sich selbst. */
function withHistory(prompt: string, history: { prompt: string; answer: string }[]): string {
	if (history.length === 0) {
		return prompt
	}
	const lines = ["Bisheriger Verlauf (Kontext, nicht erneut beantworten):", ""]
	for (const h of history.slice(-2)) {
		lines.push(`Frage: ${h.prompt.slice(0, 800)}`)
		lines.push(`Antwort: ${h.answer.slice(0, 1200)}`)
		lines.push("")
	}
	lines.push("Neue Aufgabe:", prompt)
	return lines.join("\n")
}

export default function Chat() {
	const live = useStore((s) => s.live)
	const taskDetails = useStore((s) => s.taskDetails)
	const agents = useStore((s) => s.agents)
	const loadDetail = useStore((s) => s.loadTaskDetail)
	const refreshTasks = useStore((s) => s.refreshTasks)
	const setLastError = useStore((s) => s.setLastError)

	const [turns, setTurns] = useState<Turn[]>([])
	const [input, setInput] = useState("")
	const [target, setTarget] = useState<Target>("answer")
	const [repos, setRepos] = useState<Repo[]>([])
	const [repoId, setRepoId] = useState("")
	const [keepContext, setKeepContext] = useState(true)
	const [busy, setBusy] = useState(false)
	const endRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		api
			.get<Repo[]>("/api/repos")
			.then(setRepos)
			.catch(() => setRepos([]))
	}, [])

	/** Live-Stream einer Task — die Zuordnung liefert `routing.decided`. */
	const runOf = (taskId?: string) =>
		taskId ? Object.values(live).find((r) => r.taskId === taskId) : undefined

	/** Antworttext: erst der Live-Stream, nach dem Lauf die persistierte Ausgabe. */
	const answerOf = (turn: Turn): string => {
		const run = runOf(turn.taskId)
		if (run?.text) {
			return run.text
		}
		const detail = turn.taskId ? taskDetails[turn.taskId] : undefined
		const last = detail?.executions.at(-1)
		return last?.output ?? ""
	}

	const send = async () => {
		const text = input.trim()
		if (!text || busy) {
			return
		}
		if (target === "repo" && !repoId) {
			setLastError(
				repos.length === 0
					? "Kein Repository angebunden — unter „GitHub“ verbinden, dann erscheint es hier"
					: "Bitte ein Repository wählen — oder Ziel auf „Projekt anlegen“ stellen",
			)
			return
		}
		const id = crypto.randomUUID()
		const repoLabel = repos.find((r) => r.id === repoId)?.fullName
		setTurns((t) => [...t, { id, prompt: text, target, repoLabel, status: "sending" }])
		setInput("")
		setBusy(true)
		try {
			const history = turns
				.filter((t) => t.status === "done")
				.map((t) => ({ prompt: t.prompt, answer: answerOf(t) }))
			const task = await api.post<Task>("/api/tasks", {
				title: titleFrom(text),
				prompt: keepContext ? withHistory(text, history) : text,
				// Agentik-Modus: nur wenn der Spezialist wirklich Dateien anfassen soll.
				metadata: { privacy: "local-only", mode: "auto", agentMode: target !== "answer" },
				assignmentMode: "auto",
			})
			if (target === "repo") {
				await api.put(`/api/tasks/${task.id}/repo`, { repoId })
			}
			await api.post(`/api/tasks/${task.id}/start`)
			setTurns((t) => t.map((x) => (x.id === id ? { ...x, taskId: task.id, status: "running" } : x)))
			// Detail laden: Ab jetzt hält der Store es bei jedem Event aktuell —
			// daher kommt der Name des gewählten Spezialisten.
			void loadDetail(task.id)
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			setTurns((t) => t.map((x) => (x.id === id ? { ...x, status: "failed", error: message } : x)))
			setLastError(message)
		} finally {
			setBusy(false)
		}
	}

	const cancel = async (taskId: string) => {
		try {
			await api.post(`/api/tasks/${taskId}/cancel`)
			await refreshTasks()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	// Status aus dem Store nachziehen: Der Lauf endet über ein SSE-Event, nicht
	// über eine Antwort auf unseren Aufruf.
	useEffect(() => {
		setTurns((t) =>
			t.map((turn) => {
				if (!turn.taskId || turn.status === "done" || turn.status === "failed") {
					return turn
				}
				const run = Object.values(live).find((r) => r.taskId === turn.taskId)
				if (run?.status === "done") {
					return { ...turn, status: "done" }
				}
				if (run?.status === "failed") {
					const detail = taskDetails[turn.taskId]
					return { ...turn, status: "failed", error: detail?.executions.at(-1)?.error ?? "Lauf gescheitert" }
				}
				return turn
			}),
		)
	}, [live, taskDetails])

	// Neue Nachricht soll sichtbar sein, ohne dass man scrollen muss.
	useEffect(() => {
		if (turns.length > 0) {
			endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
		}
	}, [turns.length])

	const activeTarget = TARGETS.find((t) => t.id === target)

	return (
		<div className="fade-in chat-view">
			<div className="page-head">
				<div>
					<h1>Chat</h1>
					<p className="page-sub">
						Beschreib die Aufgabe. DiriZ wählt automatisch den passenden Spezialisten aus {agents.length} und
						arbeitet damit — antworten, ein Projekt anlegen oder ein Repository ändern.
					</p>
				</div>
			</div>

			<div className="chat-log">
				{turns.length === 0 && (
					<div className="empty">
						<span className="icon-chip">
							<IconChat size={20} />
						</span>
						<div className="empty-title">Noch keine Nachricht</div>
						<p>
							Zum Beispiel: „Schreib eine React-Komponente für das Login-Formular“, „Der Import stürzt mit
							einer Exception ab, finde die Ursache“ oder „Prüfe die Anmeldung auf SQL-Injection“.
						</p>
					</div>
				)}

				{turns.map((turn) => {
					const detail = turn.taskId ? taskDetails[turn.taskId] : undefined
					const run = runOf(turn.taskId)
					const answer = answerOf(turn)
					const agentName = detail?.agentSelection?.agentName
					const reason = detail?.agentSelection?.reason
					const files = detail?.files ?? []
					const toolOps = run?.toolOps ?? []
					return (
						<div key={turn.id} className="chat-turn">
							<div className="chat-msg user">
								<div className="chat-role">Du</div>
								<div className="chat-body">{turn.prompt}</div>
								<div className="chat-meta">
									<span className="pill no-dot">{TARGETS.find((t) => t.id === turn.target)?.label}</span>
									{turn.repoLabel && <span className="pill no-dot">{turn.repoLabel}</span>}
								</div>
							</div>

							<div className="chat-msg agent">
								<div className="chat-role">
									<IconAgents size={14} />
									{agentName ?? (turn.status === "sending" ? "wird zugeordnet …" : "Spezialist")}
									<span className={`pill ${turn.status}`}>{turn.status}</span>
									{turn.status === "running" && turn.taskId && (
										<button
											type="button"
											className="btn ghost sm"
											onClick={() => void cancel(turn.taskId as string)}
										>
											<IconStop size={13} />
											Abbrechen
										</button>
									)}
								</div>
								{reason && <div className="chat-reason">{reason}</div>}
								{run && run.failovers.length > 0 && (
									<div className="chat-reason">Failover: {run.failovers.join(" · ")}</div>
								)}
								{toolOps.length > 0 && (
									<ul className="chat-tools">
										{toolOps.map((op) => (
											<li key={op.id} className={op.ok ? "ok" : "err"}>
												<IconDoc size={12} /> {op.name} — {op.argsSummary}
											</li>
										))}
									</ul>
								)}
								{answer ? (
									<pre className={`output ${turn.status === "running" ? "live-cursor" : ""}`}>{answer}</pre>
								) : (
									turn.status !== "failed" && <div className="chat-waiting">arbeitet …</div>
								)}
								{turn.error && <div className="chat-error">{turn.error}</div>}
								{files.length > 0 && (
									<div className="chat-files">
										<strong>Dateien:</strong>{" "}
										{files.map((f) => (
											<span key={f.relPath} className="pill no-dot">
												{f.relPath}
											</span>
										))}
									</div>
								)}
							</div>
						</div>
					)
				})}
				<div ref={endRef} />
			</div>

			<div className="chat-composer card">
				<div className="chat-targets">
					{TARGETS.map((t) => (
						<button
							key={t.id}
							type="button"
							className={`btn ${target === t.id ? "primary" : ""}`}
							onClick={() => setTarget(t.id)}
							aria-pressed={target === t.id}
						>
							{t.id === "answer" && <IconChat size={14} />}
							{t.id === "workspace" && <IconWorkspace size={14} />}
							{t.id === "repo" && <IconGitBranch size={14} />}
							{t.label}
						</button>
					))}
					{target === "repo" &&
						(repos.length > 0 ? (
							<select value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository">
								<option value="">Repository wählen …</option>
								{repos.map((r) => (
									<option key={r.id} value={r.id} disabled={!r.localPath}>
										{r.fullName}
										{r.localPath ? "" : " (wird geklont)"}
									</option>
								))}
							</select>
						) : (
							// Ohne diesen Hinweis steht hier nur eine leere Auswahl, und niemand
							// erfährt, dass ein Repository erst angebunden werden muss.
							<a className="btn" href="/github">
								<IconGitBranch size={14} />
								Kein Repository angebunden — jetzt verbinden
							</a>
						))}
					<label className="chat-context">
						<input type="checkbox" checked={keepContext} onChange={(e) => setKeepContext(e.target.checked)} />
						Verlauf mitsenden
					</label>
				</div>
				{activeTarget && <p className="field-hint">{activeTarget.hint}</p>}
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							void send()
						}
					}}
					rows={3}
					placeholder="Aufgabe beschreiben … (Enter sendet, Umschalt+Enter macht eine neue Zeile)"
				/>
				<div className="chat-actions">
					{turns.length > 0 && (
						<button type="button" className="btn ghost" onClick={() => setTurns([])}>
							<IconTrash size={14} />
							Verlauf leeren
						</button>
					)}
					<button
						type="button"
						className="btn primary"
						onClick={() => void send()}
						disabled={busy || input.trim().length === 0}
					>
						<IconPlay size={14} />
						Senden
					</button>
				</div>
			</div>
		</div>
	)
}
