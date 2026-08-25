import type {
	PrivacyMode,
	PromptTemplate,
	RoutePreview,
	RoutingDecision,
	RoutingMode,
	Task,
} from "@diriz/shared"
import { type CSSProperties, useEffect, useState } from "react"
import {
	IconCheck,
	IconClose,
	IconEdit,
	IconFailover,
	IconFile,
	IconPlay,
	IconPlus,
	IconQueue,
	IconRoute,
	IconSparkles,
	IconStar,
	IconStop,
	IconTasks,
	IconTemplate,
	IconTool,
	IconTrash,
	IconXCircle,
} from "../components/icons.js"
import Markdown from "../components/Markdown.js"
import TaskGitPanel from "../components/TaskGitPanel.js"
import { api } from "../lib/api.js"
import type { TaskDetail } from "../store.js"
import { useStore } from "../store.js"

/** Entwurf beim Bearbeiten einer Task. */
interface TaskDraft {
	title: string
	prompt: string
	assignment: "auto" | "agent" | "swarm"
	agentId: string
	swarmId: string
	ovTemp: string
	ovMax: string
	ovSystem: string
}

export default function Tasks() {
	const tasks = useStore((s) => s.tasks)
	const agents = useStore((s) => s.agents)
	const swarms = useStore((s) => s.swarms)
	const live = useStore((s) => s.live)
	const taskDetails = useStore((s) => s.taskDetails)
	const refresh = useStore((s) => s.refreshTasks)
	const loadDetail = useStore((s) => s.loadTaskDetail)
	const setLastError = useStore((s) => s.setLastError)

	const [selected, setSelected] = useState<string | undefined>(undefined)
	const [showForm, setShowForm] = useState(false)
	const [showQueue, setShowQueue] = useState(false)
	const queueCount = tasks.filter((t) => t.status === "queued").length
	const activeCount = tasks.filter((t) => t.status === "running").length
	const [title, setTitle] = useState("")
	const [prompt, setPrompt] = useState("")
	const [privacy, setPrivacy] = useState<PrivacyMode>("local-only")
	const [mode, setMode] = useState<RoutingMode>("auto")
	const [budget, setBudget] = useState("")
	const [agentMode, setAgentMode] = useState(false)
	const [assignment, setAssignment] = useState<"auto" | "agent" | "swarm">("auto")
	const [agentId, setAgentId] = useState("")
	const [swarmId, setSwarmId] = useState("")
	const [ovTemp, setOvTemp] = useState("")
	const [ovMax, setOvMax] = useState("")
	const [ovSystem, setOvSystem] = useState("")
	const [showOverrides, setShowOverrides] = useState(false)
	const [busy, setBusy] = useState(false)
	const [templates, setTemplates] = useState<PromptTemplate[]>([])
	const [tplName, setTplName] = useState("")
	const [preview, setPreview] = useState<RoutePreview | undefined>(undefined)
	const [previewBusy, setPreviewBusy] = useState(false)

	// Bearbeiten: Task (Titel, Prompt, Zuweisung, Overrides) und Vorlagen.
	const [editTask, setEditTask] = useState<string | null>(null)
	const [tDraft, setTDraft] = useState<TaskDraft | null>(null)
	const [editTpl, setEditTpl] = useState<string | null>(null)
	const [tplDraftName, setTplDraftName] = useState("")
	const [tplDraftPrompt, setTplDraftPrompt] = useState("")

	useEffect(() => {
		if (selected) {
			void loadDetail(selected)
		} else {
			setPreview(undefined)
		}
	}, [selected, loadDetail])

	const loadTemplates = () => {
		void api
			.get<PromptTemplate[]>("/api/templates")
			.then(setTemplates)
			.catch(() => {})
	}

	useEffect(loadTemplates, [])

	const createTask = async () => {
		setBusy(true)
		try {
			const overrides =
				ovTemp !== "" || ovMax !== "" || ovSystem !== ""
					? {
							temperature: ovTemp === "" ? undefined : Number(ovTemp),
							maxTokens: ovMax === "" ? undefined : Number(ovMax),
							systemPrompt: ovSystem || undefined,
						}
					: undefined
			const task = await api.post<Task>("/api/tasks", {
				title,
				prompt,
				metadata: { privacy, mode, budgetUsd: budget ? Number(budget) : undefined, agentMode },
				assignmentMode: assignment,
				agentId: assignment === "agent" ? agentId || undefined : undefined,
				swarmId: assignment === "swarm" ? swarmId || undefined : undefined,
				overrides,
			})
			setTitle("")
			setPrompt("")
			setBudget("")
			setAgentMode(false)
			setOvTemp("")
			setOvMax("")
			setOvSystem("")
			setShowForm(false)
			await refresh()
			setSelected(task.id)
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const act = async (path: string) => {
		try {
			await api.post(path)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const remove = async (id: string) => {
		try {
			await api.del(`/api/tasks/${id}`)
			if (selected === id) {
				setSelected(undefined)
			}
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const startEditTask = (task: Task) => {
		if (editTask === task.id) {
			setEditTask(null)
			return
		}
		setEditTask(task.id)
		setTDraft({
			title: task.title,
			prompt: task.prompt,
			assignment: task.assignmentMode ?? "auto",
			agentId: task.agentId ?? "",
			swarmId: task.swarmId ?? "",
			ovTemp: task.overrides?.temperature !== undefined ? String(task.overrides.temperature) : "",
			ovMax: task.overrides?.maxTokens !== undefined ? String(task.overrides.maxTokens) : "",
			ovSystem: task.overrides?.systemPrompt ?? "",
		})
	}

	const saveTask = async () => {
		if (!editTask || !tDraft) return
		setBusy(true)
		try {
			const hasOverrides = tDraft.ovTemp !== "" || tDraft.ovMax !== "" || tDraft.ovSystem !== ""
			await api.patch(`/api/tasks/${editTask}`, {
				title: tDraft.title,
				prompt: tDraft.prompt,
				assignmentMode: tDraft.assignment,
				agentId: tDraft.assignment === "agent" ? tDraft.agentId || null : null,
				swarmId: tDraft.assignment === "swarm" ? tDraft.swarmId || null : null,
				overrides: hasOverrides
					? {
							temperature: tDraft.ovTemp === "" ? undefined : Number(tDraft.ovTemp),
							maxTokens: tDraft.ovMax === "" ? undefined : Number(tDraft.ovMax),
							systemPrompt: tDraft.ovSystem || undefined,
						}
					: null,
			})
			setEditTask(null)
			setTDraft(null)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const startEditTemplate = (tpl: PromptTemplate) => {
		if (editTpl === tpl.id) {
			setEditTpl(null)
			return
		}
		setEditTpl(tpl.id)
		setTplDraftName(tpl.name)
		setTplDraftPrompt(tpl.prompt)
	}

	const updateTemplate = async () => {
		if (!editTpl) return
		try {
			await api.patch(`/api/templates/${editTpl}`, { name: tplDraftName.trim(), prompt: tplDraftPrompt })
			setEditTpl(null)
			loadTemplates()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const saveTemplate = async () => {
		try {
			await api.post("/api/templates", { name: tplName.trim(), prompt: ovSystem })
			setTplName("")
			loadTemplates()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const removeTemplate = async (id: string) => {
		try {
			await api.del(`/api/templates/${id}`)
			loadTemplates()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const runPreview = async (id: string) => {
		setPreviewBusy(true)
		try {
			setPreview(await api.post<RoutePreview>(`/api/tasks/${id}/preview`))
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setPreviewBusy(false)
		}
	}

	const detail: TaskDetail | undefined = selected ? taskDetails[selected] : undefined
	/** Die ausgewählte Task selbst — der Detail-Datensatz enthält sie nicht. */
	const selectedTask = selected ? tasks.find((t) => t.id === selected) : undefined
	const liveRuns = detail ? Object.entries(live).filter(([, r]) => r.status === "running") : []
	const queuedTasks = tasks.filter((t) => t.status === "queued")

	return (
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Tasks</h1>
					<p className="page-sub">
						Aufträge an DiriZ — jede Task wird nachvollziehbar auf das passende Modell geroutet.
					</p>
				</div>
				<div className="page-actions">
					<button
						type="button"
						className={`btn ${showQueue ? "primary" : ""}`}
						onClick={() => setShowQueue((v) => !v)}
						aria-expanded={showQueue}
					>
						<IconQueue size={15} />
						Queue ({queueCount})
					</button>
					{activeCount > 0 && <span className="pill running">{activeCount} aktiv</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => setShowForm((v) => !v)}
						aria-expanded={showForm}
					>
						{showForm ? <IconClose size={15} /> : <IconPlus size={15} />}
						{showForm ? "Abbrechen" : "Neue Task"}
					</button>
				</div>
			</div>

			{showQueue && (
				<div className="card">
					<div className="card-head">
						<div className="card-title">
							<IconQueue size={16} />
							Warteschlange
						</div>
						<span className="badge">{queuedTasks.length}</span>
					</div>
					{queuedTasks.length === 0 ? (
						<p className="muted text-sm" style={{ marginTop: 10 }}>
							Keine Tasks in der Warteschlange.
						</p>
					) : (
						<div className="table-wrap" style={{ marginTop: 10 }}>
							<table className="table">
								<thead>
									<tr>
										<th>Titel</th>
										<th>Status</th>
										<th>Erstellt</th>
									</tr>
								</thead>
								<tbody>
									{queuedTasks.map((t) => (
										<tr
											key={t.id}
											onClick={() => setSelected(t.id)}
											style={{ cursor: "pointer" }}
											className={selected === t.id ? "selected" : ""}
										>
											<td>{t.title || t.prompt.slice(0, 48)}</td>
											<td>
												<span className={`pill ${t.status}`}>{t.status}</span>
											</td>
											<td className="muted">{new Date(t.createdAt).toLocaleTimeString("de-DE")}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}

			{showForm && (
				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">
								<IconPlus size={16} />
								Neue Task
							</div>
							<div className="card-sub">
								Die Task startet direkt nach dem Anlegen — später jederzeit erneut startbar.
							</div>
						</div>
					</div>

					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field grow">
							Titel (optional)
							<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="z. B. Auth-Fix" />
						</label>
						<label className="field">
							Privatsphäre
							<select value={privacy} onChange={(e) => setPrivacy(e.target.value as PrivacyMode)}>
								<option value="local-only">local-only</option>
								<option value="allow-cloud">allow-cloud</option>
							</select>
						</label>
						<label className="field">
							Modus
							<select value={mode} onChange={(e) => setMode(e.target.value as RoutingMode)}>
								<option value="auto">auto</option>
								<option value="round-robin">round-robin</option>
								<option value="cost-aware">cost-aware</option>
								<option value="pinned">pinned</option>
							</select>
						</label>
						<label className="field">
							Budget USD (optional)
							<input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0.50" />
						</label>
						<label
							className="check-chip"
							style={{ marginBottom: 6 }}
							title="Agentik-Modus (M8): Das Modell arbeitet selbst im Workspace — lesen und suchen, Dateien anlegen, ändern, verschieben und löschen, und mit run_command Programme ausführen. Jede Operation wird live angezeigt."
						>
							<input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} />
							Agentik
						</label>
					</div>

					<label className="field" style={{ marginTop: 14 }}>
						Prompt
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder="Was soll das Ergebnis sein?"
						/>
					</label>

					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field">
							Spezialist-Zuweisung
							<select
								value={assignment}
								onChange={(e) => setAssignment(e.target.value as "auto" | "agent" | "swarm")}
							>
								<option value="auto">auto (Prompt-Match)</option>
								<option value="agent">fester Spezialist</option>
								<option value="swarm">Swarm</option>
							</select>
						</label>
						{assignment === "agent" && (
							<label className="field">
								Spezialist
								<select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
									<option value="">— wählen —</option>
									{agents
										.filter((a) => a.enabled)
										.map((a) => (
											<option key={a.id} value={a.id}>
												{a.name}
											</option>
										))}
								</select>
							</label>
						)}
						{assignment === "swarm" && (
							<label className="field">
								Swarm
								<select value={swarmId} onChange={(e) => setSwarmId(e.target.value)}>
									<option value="">— wählen —</option>
									{swarms
										.filter((x) => x.enabled)
										.map((x) => (
											<option key={x.id} value={x.id}>
												{x.name}
											</option>
										))}
								</select>
							</label>
						)}
						<button
							type="button"
							className={`btn ${showOverrides ? "primary" : ""}`}
							onClick={() => setShowOverrides((v) => !v)}
							aria-expanded={showOverrides}
						>
							<IconSparkles size={15} />
							Erweiterte Settings
						</button>
					</div>

					{showOverrides && (
						<>
							<div className="divider" />
							<div className="row" style={{ alignItems: "flex-end" }}>
								<label className="field">
									Override Temperatur
									<input
										type="number"
										step="0.1"
										min={0}
										max={2}
										value={ovTemp}
										onChange={(e) => setOvTemp(e.target.value)}
										placeholder="—"
									/>
								</label>
								<label className="field">
									Override Max-Tokens
									<input
										type="number"
										min={1}
										value={ovMax}
										onChange={(e) => setOvMax(e.target.value)}
										placeholder="—"
									/>
								</label>
								<label className="field">
									Vorlage übernehmen
									<select
										value=""
										onChange={(e) => {
											const t = templates.find((x) => x.id === e.target.value)
											if (t) setOvSystem(t.prompt)
										}}
									>
										<option value="">— Vorlage wählen —</option>
										{templates.map((t) => (
											<option key={t.id} value={t.id}>
												{t.name}
											</option>
										))}
									</select>
								</label>
							</div>

							<label className="field" style={{ marginTop: 12 }}>
								Override System-Prompt
								<textarea
									value={ovSystem}
									onChange={(e) => setOvSystem(e.target.value)}
									placeholder="Task-spezifische Anweisung …"
								/>
							</label>

							<div style={{ marginTop: 14 }}>
								<div className="card-title">
									<IconTemplate size={16} />
									Vorlagen verwalten
								</div>
								<div className="chip-group" style={{ marginTop: 8 }}>
									{templates.map((t) => (
										<span key={t.id} className="chip">
											<button
												type="button"
												className="linklike"
												title="In System-Prompt übernehmen"
												onClick={() => setOvSystem(t.prompt)}
											>
												{t.name}
											</button>
											<button
												type="button"
												className="icon-btn sm"
												aria-label={`Vorlage ${t.name} bearbeiten`}
												title="Vorlage bearbeiten"
												onClick={() => startEditTemplate(t)}
											>
												<IconEdit size={13} />
											</button>
											<button
												type="button"
												className="icon-btn sm danger"
												aria-label={`Vorlage ${t.name} löschen`}
												title="Vorlage löschen"
												onClick={() => void removeTemplate(t.id)}
											>
												<IconTrash size={13} />
											</button>
										</span>
									))}
									{templates.length === 0 && <span className="faint text-sm">Keine Vorlagen vorhanden.</span>}
								</div>

								{editTpl && (
									<div className="subpanel">
										<label className="field" style={{ maxWidth: 320 }}>
											Vorlagen-Name
											<input value={tplDraftName} onChange={(e) => setTplDraftName(e.target.value)} />
										</label>
										<label className="field" style={{ marginTop: 10 }}>
											Vorlagen-Prompt
											<textarea value={tplDraftPrompt} onChange={(e) => setTplDraftPrompt(e.target.value)} />
										</label>
										<div className="row" style={{ marginTop: 12 }}>
											<button
												type="button"
												className="btn primary"
												onClick={() => void updateTemplate()}
												disabled={tplDraftName.trim().length === 0 || tplDraftPrompt.trim().length === 0}
											>
												Vorlage speichern
											</button>
											<button type="button" className="btn ghost" onClick={() => setEditTpl(null)}>
												Abbrechen
											</button>
										</div>
									</div>
								)}

								<div className="row" style={{ marginTop: 12 }}>
									<input
										value={tplName}
										onChange={(e) => setTplName(e.target.value)}
										placeholder="Neue Vorlage — Name"
										style={{ minWidth: 280 }}
										aria-label="Name der neuen Vorlage"
									/>
									<button
										type="button"
										className="btn"
										onClick={() => void saveTemplate()}
										disabled={tplName.trim().length === 0 || ovSystem.trim().length === 0}
										title="Speichert den aktuellen System-Prompt als Vorlage"
									>
										Vorlage speichern
									</button>
								</div>
							</div>
						</>
					)}

					<div className="row" style={{ marginTop: 16 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void createTask()}
							disabled={
								busy ||
								prompt.trim().length === 0 ||
								(assignment === "agent" && !agentId) ||
								(assignment === "swarm" && !swarmId)
							}
						>
							{busy ? "Lege an …" : "Task anlegen"}
						</button>
						<span className="faint text-sm">Startet direkt nach dem Anlegen — oder später via „Start“.</span>
					</div>
				</div>
			)}

			<div className="card">
				<div className="table-wrap">
					<table className="table">
						<thead>
							<tr>
								<th>Titel</th>
								<th>Status</th>
								<th>Privatsphäre</th>
								<th>Erstellt</th>
								<th className="actions-cell">Aktionen</th>
							</tr>
						</thead>
						<tbody>
							{tasks.map((t) => (
								<tr key={t.id} className={selected === t.id ? "selected" : ""}>
									<td>
										<div className="cell-title">
											<button type="button" className="linklike" onClick={() => setSelected(t.id)}>
												<strong>{t.title || t.prompt.slice(0, 48)}</strong>
											</button>
											{t.running && <span className="pill running">läuft</span>}
										</div>
									</td>
									<td>
										<span className={`pill ${t.status}`}>{t.status}</span>
									</td>
									<td className="muted">{t.metadata.privacy}</td>
									<td className="muted">{new Date(t.createdAt).toLocaleString("de-DE")}</td>
									<td className="actions-cell">
										<div className="actions">
											<button
												type="button"
												className={`icon-btn ${editTask === t.id ? "active" : ""}`}
												onClick={() => startEditTask(t)}
												disabled={t.running}
												aria-label={`${t.title} bearbeiten`}
												title={
													t.running ? "Laufende Tasks können nicht bearbeitet werden" : "Task bearbeiten"
												}
											>
												<IconEdit size={16} />
											</button>
											<button
												type="button"
												className="btn sm"
												title="Ausführung starten"
												onClick={() => void act(`/api/tasks/${t.id}/start`)}
											>
												<IconPlay size={13} />
												Start
											</button>
											<button
												type="button"
												className="icon-btn"
												aria-label={`${t.title} abbrechen`}
												title="Abbrechen"
												onClick={() => void act(`/api/tasks/${t.id}/cancel`)}
												disabled={!t.running}
											>
												<IconStop size={16} />
											</button>
											<button
												type="button"
												className="icon-btn danger"
												aria-label={`${t.title} löschen`}
												title="Löschen"
												onClick={() => void remove(t.id)}
											>
												<IconTrash size={16} />
											</button>
										</div>
									</td>
								</tr>
							))}
							{tasks.length === 0 && (
								<tr>
									<td colSpan={5}>
										<div className="empty">
											<span className="icon-chip lg" style={{ "--mc": "var(--accent)" } as CSSProperties}>
												<IconTasks size={20} />
											</span>
											<span className="empty-title">Noch keine Tasks</span>
											<p>Formuliere deinen ersten Auftrag — DiriZ wählt automatisch das passende Modell.</p>
											<button type="button" className="btn primary" onClick={() => setShowForm(true)}>
												<IconPlus size={15} />
												Jetzt loslegen
											</button>
										</div>
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{editTask && tDraft && (
				<div className="card">
					<div className="card-head">
						<div className="card-title">
							<IconEdit size={16} />
							Task bearbeiten: {tasks.find((t) => t.id === editTask)?.title ?? editTask}
						</div>
						<button
							type="button"
							className="icon-btn"
							aria-label="Bearbeiten schließen"
							onClick={() => setEditTask(null)}
						>
							<IconClose size={16} />
						</button>
					</div>
					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field grow">
							Titel
							<input value={tDraft.title} onChange={(e) => setTDraft({ ...tDraft, title: e.target.value })} />
						</label>
						<label className="field">
							Spezialist-Zuweisung
							<select
								value={tDraft.assignment}
								onChange={(e) =>
									setTDraft({ ...tDraft, assignment: e.target.value as "auto" | "agent" | "swarm" })
								}
							>
								<option value="auto">auto (Prompt-Match)</option>
								<option value="agent">fester Spezialist</option>
								<option value="swarm">Swarm</option>
							</select>
						</label>
						{tDraft.assignment === "agent" && (
							<label className="field">
								Spezialist
								<select
									value={tDraft.agentId}
									onChange={(e) => setTDraft({ ...tDraft, agentId: e.target.value })}
								>
									<option value="">— wählen —</option>
									{agents
										.filter((a) => a.enabled)
										.map((a) => (
											<option key={a.id} value={a.id}>
												{a.name}
											</option>
										))}
								</select>
							</label>
						)}
						{tDraft.assignment === "swarm" && (
							<label className="field">
								Swarm
								<select
									value={tDraft.swarmId}
									onChange={(e) => setTDraft({ ...tDraft, swarmId: e.target.value })}
								>
									<option value="">— wählen —</option>
									{swarms
										.filter((x) => x.enabled)
										.map((x) => (
											<option key={x.id} value={x.id}>
												{x.name}
											</option>
										))}
								</select>
							</label>
						)}
					</div>
					<label className="field" style={{ marginTop: 12 }}>
						Prompt
						<textarea
							value={tDraft.prompt}
							onChange={(e) => setTDraft({ ...tDraft, prompt: e.target.value })}
						/>
					</label>
					<div className="row" style={{ marginTop: 12, alignItems: "flex-start" }}>
						<label className="field">
							Override Temperatur
							<input
								type="number"
								step="0.1"
								min={0}
								max={2}
								value={tDraft.ovTemp}
								onChange={(e) => setTDraft({ ...tDraft, ovTemp: e.target.value })}
								placeholder="—"
							/>
						</label>
						<label className="field">
							Override Max-Tokens
							<input
								type="number"
								min={1}
								value={tDraft.ovMax}
								onChange={(e) => setTDraft({ ...tDraft, ovMax: e.target.value })}
								placeholder="—"
							/>
						</label>
						<label className="field grow">
							Override System-Prompt
							<textarea
								value={tDraft.ovSystem}
								onChange={(e) => setTDraft({ ...tDraft, ovSystem: e.target.value })}
								placeholder="Task-spezifische Anweisung …"
							/>
						</label>
					</div>
					<div className="row" style={{ marginTop: 14 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void saveTask()}
							disabled={
								busy ||
								tDraft.prompt.trim().length === 0 ||
								(tDraft.assignment === "agent" && !tDraft.agentId) ||
								(tDraft.assignment === "swarm" && !tDraft.swarmId)
							}
						>
							{busy ? "Speichere …" : "Speichern"}
						</button>
						<button type="button" className="btn ghost" onClick={() => setEditTask(null)}>
							Abbrechen
						</button>
					</div>
				</div>
			)}

			{selected && (
				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">
								<IconTasks size={16} />
								{tasks.find((t) => t.id === selected)?.title ?? selected}
							</div>
							<div className="card-sub">
								{detail?.executions.length ?? 0} Executions · {detail?.files.length ?? 0} Dateien
							</div>
						</div>
						<div className="row tight">
							<button
								type="button"
								className="btn"
								onClick={() => void runPreview(selected)}
								disabled={previewBusy}
							>
								<IconRoute size={15} />
								{previewBusy ? "Prüfe …" : "Routing-Vorschau (Dry-Run)"}
							</button>
							<button
								type="button"
								className="icon-btn"
								aria-label="Detail schließen"
								onClick={() => setSelected(undefined)}
							>
								<IconClose size={16} />
							</button>
						</div>
					</div>

					{preview && preview.taskId === selected && (
						<div style={{ marginTop: 16 }}>
							<div className="card-title">
								<IconRoute size={15} />
								Routing-Vorschau — würde gewählt werden
							</div>
							<div className="card-sub">
								{preview.agentName ? `Spezialist „${preview.agentName}“` : "kein Spezialist"}
								{preview.agentReason ? ` (${preview.agentReason})` : ""}
							</div>
							<DecisionView decision={preview.decision} />
						</div>
					)}

					{/* Wie im Chat: die Antwort als Markdown, damit Code-Blöcke auch hier
					    zugeklappte Akkordeons sind statt einer Textwand. Ein noch
					    offener Code-Zaun wird beim Rendern mitgeführt — der Block wächst
					    also live mit. */}
					{liveRuns.length > 0 && (
						<div className="output live-cursor md" style={{ marginTop: 14 }}>
							<Markdown source={liveRuns.map(([, run]) => run.text).join("")} />
						</div>
					)}

					{liveRuns.length > 0 && liveRuns.flatMap(([, r]) => r.failovers).length > 0 && (
						<div className="stack" style={{ marginTop: 8, gap: 2 }}>
							{liveRuns
								.flatMap(([, r]) => r.failovers)
								.map((f) => (
									<div key={f} className="text-warn row tight text-sm">
										<IconFailover size={14} />
										{f}
									</div>
								))}
						</div>
					)}

					{liveRuns.length > 0 && liveRuns.flatMap(([, r]) => r.toolOps ?? []).length > 0 && (
						<div style={{ marginTop: 12 }}>
							<div className="card-title">
								<IconTool size={15} />
								Agentik-Operationen
							</div>
							<div className="stack" style={{ marginTop: 6, gap: 2 }}>
								{liveRuns
									.flatMap(([, r]) => r.toolOps ?? [])
									.map((op) => (
										<div key={op.id} className={`mono text-sm row tight ${op.ok ? "text-ok" : "text-err"}`}>
											{op.ok ? <IconCheck size={13} /> : <IconXCircle size={13} />}
											{op.name}({op.argsSummary})
										</div>
									))}
							</div>
						</div>
					)}

					{detail && detail.executions.length > 0 && (
						<div className="table-wrap" style={{ marginTop: 16 }}>
							<table className="table">
								<thead>
									<tr>
										<th>Status</th>
										<th className="num">Tokens in/out</th>
										<th className="num">tok/s</th>
										<th className="num">Kosten</th>
										<th>Fehler</th>
										<th>Bewertung</th>
									</tr>
								</thead>
								<tbody>
									{[...detail.executions].reverse().map((e) => (
										<tr key={e.id}>
											<td>
												<div className="cell-title">
													<span className={`pill ${e.status}`}>{e.status}</span>
													{e.failoverCount > 0 && (
														<span className="badge warn" title="Failover-Wechsel">
															<IconFailover size={11} />
															{e.failoverCount}
														</span>
													)}
												</div>
											</td>
											<td className="num">
												{e.tokensIn ?? 0} / {e.tokensOut ?? 0}
											</td>
											<td className="num">{e.tpsAvg ?? "–"}</td>
											<td className="num">{e.costUsd !== undefined ? `${e.costUsd.toFixed(4)} $` : "–"}</td>
											<td className="muted text-sm">{e.error ?? ""}</td>
											<td>
												<StarRating executionId={e.id} value={e.rating} disabled={e.status === "running"} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					{/* GitHub (M10): Repo pinnen, Diff ansehen, committen und pushen. */}
					{selectedTask && (
						<TaskGitPanel
							task={selectedTask}
							onTaskChanged={() => {
								void useStore.getState().refreshTasks()
								void loadDetail(selectedTask.id)
							}}
						/>
					)}

					{detail && detail.files.length > 0 && (
						<div style={{ marginTop: 16 }}>
							<div className="card-title">
								<IconFile size={15} />
								Dateien (Workspace)
							</div>
							<div className="chip-group" style={{ marginTop: 8 }}>
								{detail.files.map((f) => (
									<span key={f.relPath} className="chip">
										{f.relPath} <b>{f.size} B</b>
									</span>
								))}
							</div>
						</div>
					)}

					{detail?.agentSelection && (
						<div style={{ marginTop: 16 }}>
							<div className="card-title">Spezialisten-Zuordnung</div>
							<div className="card-sub">
								{detail.agentSelection.agentName ? (
									<>
										Gewählt: <strong>{detail.agentSelection.agentName}</strong>
									</>
								) : (
									<>Kein Spezialist (freies Routing)</>
								)}
								{detail.agentSelection.reason && <> — {detail.agentSelection.reason}</>}
							</div>
							{detail.agentSelection.candidates.length > 0 && (
								<div className="chip-group" style={{ marginTop: 8 }}>
									{[...detail.agentSelection.candidates]
										.sort((a, b) => b.score - a.score)
										.map((c) => (
											<span
												key={c.agentId}
												className={`badge ${c.agentId === detail.agentSelection?.agentId ? "accent" : ""}`}
												style={{ opacity: c.score === 0 ? 0.55 : 1 }}
											>
												{c.name} · {c.score}
											</span>
										))}
								</div>
							)}
						</div>
					)}

					{detail && detail.decisions.length > 0 && (
						<div style={{ marginTop: 16 }}>
							<div className="card-title">
								<IconRoute size={15} />
								Routing-Entscheidung (Explainability)
							</div>
							<DecisionView decision={detail.decisions[0]} />
						</div>
					)}
				</div>
			)}
		</div>
	)
}

function DecisionView({ decision }: { decision: RoutingDecision }) {
	const chosen = decision.candidates.find((c) => c.instanceId === decision.chosenInstanceId)
	return (
		<div>
			{chosen && (
				<div className="card-sub">
					Gewählt: <strong>{chosen.modelId}</strong> — Score {chosen.score}/100
				</div>
			)}
			<div className="table-wrap" style={{ marginTop: 10 }}>
				<table className="table">
					<thead>
						<tr>
							<th>Modell</th>
							<th className="num">Score</th>
							{chosen?.axes.map((a) => (
								<th key={a.key} className="num">
									{a.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{[...decision.candidates]
							.sort((a, b) => b.score - a.score)
							.map((c) => (
								<tr
									key={c.instanceId}
									className={c.instanceId === decision.chosenInstanceId ? "selected" : ""}
								>
									<td>
										<div className="cell-title">
											{c.modelId}
											{c.instanceId === decision.chosenInstanceId && (
												<span className="text-ok" title="Gewählt">
													<IconCheck size={14} />
												</span>
											)}
										</div>
									</td>
									<td className="num">
										<strong>{c.score}</strong>
									</td>
									{chosen?.axes.map((a) => {
										const mine = c.axes.find((x) => x.key === a.key)
										return (
											<td key={a.key} className="num muted mono">
												{mine ? `${(mine.value * 100).toFixed(0)}×${a.weight.toFixed(2)}` : "–"}
											</td>
										)
									})}
								</tr>
							))}
						{decision.excluded.map((x) => (
							<tr key={x.instanceId}>
								<td className="muted">{x.modelId}</td>
								<td className="num">
									<span className="badge failed">ausgeschlossen</span>
								</td>
								<td colSpan={chosen?.axes.length ?? 1} className="muted text-sm">
									{x.reason}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="faint text-sm" style={{ marginTop: 8 }}>
				Profil: est. {decision.profile.estTokens} Tokens · Privacy {decision.profile.privacy} · Modus{" "}
				{decision.profile.mode}
				{decision.profile.requiredCapabilities.length > 0 &&
					` · Pflicht: ${decision.profile.requiredCapabilities.join(", ")}`}
			</div>
		</div>
	)
}

/** Sterne-Bewertung (M7): 1–5, persistiert via Core → Qualitäts-Prior. */
function StarRating({
	executionId,
	value,
	disabled,
}: {
	executionId: string
	value?: number
	disabled?: boolean
}) {
	const [hover, setHover] = useState(0)
	const [savedVal, setSavedVal] = useState(value ?? 0)

	useEffect(() => {
		setSavedVal(value ?? 0)
	}, [value])

	const rate = async (n: number) => {
		try {
			await api.post(`/api/executions/${executionId}/rating`, { rating: n })
			setSavedVal(n)
		} catch {
			/* Fehler erscheint im Store */
		}
	}

	return (
		<span className="stars">
			{[1, 2, 3, 4, 5].map((n) => {
				const filled = n <= Math.max(hover, savedVal)
				return (
					<button
						key={n}
						type="button"
						className={`star-btn ${filled ? "filled" : ""}`}
						disabled={disabled}
						onClick={() => void rate(n)}
						onMouseEnter={() => setHover(n)}
						onMouseLeave={() => setHover(0)}
						aria-label={`${n} Sterne`}
					>
						<IconStar size={16} filled={filled} />
					</button>
				)
			})}
		</span>
	)
}
