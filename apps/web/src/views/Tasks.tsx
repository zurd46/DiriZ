import type { PrivacyMode, PromptTemplate, RoutePreview, RoutingDecision, RoutingMode, Task } from "@diriz/shared"
import { useEffect, useState } from "react"
import { api } from "../lib/api.js"
import type { TaskDetail } from "../store.js"
import { useStore } from "../store.js"

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
	const [title, setTitle] = useState("")
	const [prompt, setPrompt] = useState("")
	const [privacy, setPrivacy] = useState<PrivacyMode>("local-only")
	const [mode, setMode] = useState<RoutingMode>("auto")
	const [budget, setBudget] = useState("")
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

	useEffect(() => {
		if (selected) {
			void loadDetail(selected)
		} else {
			setPreview(undefined)
		}
	}, [selected, loadDetail])

	const loadTemplates = () => {
		void api.get<PromptTemplate[]>("/api/templates").then(setTemplates).catch(() => {})
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
				metadata: { privacy, mode, budgetUsd: budget ? Number(budget) : undefined },
				assignmentMode: assignment,
				agentId: assignment === "agent" ? agentId || undefined : undefined,
				swarmId: assignment === "swarm" ? swarmId || undefined : undefined,
				overrides,
			})
			setTitle("")
			setPrompt("")
			setBudget("")
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
	const liveRuns = detail ? Object.entries(live).filter(([, r]) => r.status === "running") : []

	return (
		<div>
			<div className="row between">
				<h1>Tasks</h1>
				<button type="button" className="btn primary" onClick={() => setShowForm((v) => !v)}>
					+ Neue Task
				</button>
			</div>

			{showForm && (
				<div className="card">
					<div className="row">
						<label className="field" style={{ flex: 1, minWidth: 220 }}>
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
					</div>
					<label className="field" style={{ marginTop: 8 }}>
						Prompt
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder="Was soll das Ergebnis sein?"
						/>
					</label>
					<div className="row" style={{ marginTop: 8 }}>
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
						<button type="button" className="btn" onClick={() => setShowOverrides((v) => !v)}>
							Erweiterte Settings
						</button>
					</div>
					{showOverrides && (
						<div className="row" style={{ marginTop: 8 }}>
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
							Vorlage → System-Prompt
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

							<label className="field" style={{ flex: 1, minWidth: 240 }}>
								Override System-Prompt
								<textarea
									value={ovSystem}
									onChange={(e) => setOvSystem(e.target.value)}
									placeholder="Task-spezifische Anweisung …"
								/>
							</label>
						</div>
					)}
				{showOverrides && (
					<div style={{ marginTop: 8 }}>
						<strong>Vorlagen verwalten</strong>
						<div className="row" style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
							{templates.map((t) => (
								<span key={t.id} className="badge">
									<button
										type="button"
										className="linklike"
										title="In System-Prompt übernehmen"
										onClick={() => setOvSystem(t.prompt)}
									>
										{t.name}
									</button>{" "}
									·{" "}
									<button type="button" className="linklike" onClick={() => void removeTemplate(t.id)}>
										✕
									</button>
								</span>
							))}
							{templates.length === 0 && <span className="muted">Keine Vorlagen vorhanden.</span>}
						</div>
						<div className="row" style={{ marginTop: 6, gap: 8 }}>
							<input
								value={tplName}
								onChange={(e) => setTplName(e.target.value)}
								placeholder="Neue Vorlage — Name (speichert aktuellen System-Prompt)"
							/>
							<button
								type="button"
								className="btn"
								onClick={() => void saveTemplate()}
								disabled={tplName.trim().length === 0 || ovSystem.trim().length === 0}
							>
								Vorlage speichern
							</button>
						</div>
					</div>
				)}

					<div className="row" style={{ marginTop: 10 }}>
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
							{busy ? "…" : "Task anlegen"}
						</button>
						<span className="muted">Startet direkt nach dem Anlegen — oder später via „Start“.</span>
					</div>
				</div>
			)}

			<div className="card">
				<table className="table">
					<thead>
						<tr>
							<th>Titel</th>
							<th>Status</th>
							<th>Privatsphäre</th>
							<th>Erstellt</th>
							<th>Aktionen</th>
						</tr>
					</thead>
					<tbody>
						{tasks.map((t) => (
							<tr
								key={t.id}
								style={{ cursor: "pointer", background: selected === t.id ? "var(--panel-2)" : undefined }}
							>
								<td>
									<button type="button" className="linklike" onClick={() => setSelected(t.id)}>
										<strong>{t.title}</strong>
									</button>
									{t.running && (
										<span className="badge running" style={{ marginLeft: 6 }}>
											läuft
										</span>
									)}
								</td>
								<td>
									<span className={`badge ${t.status}`}>{t.status}</span>
								</td>
								<td className="muted">{t.metadata.privacy}</td>
								<td className="muted">{new Date(t.createdAt).toLocaleString("de-DE")}</td>
								<td className="row">
									<button
										type="button"
										className="btn primary"
										onClick={() => void act(`/api/tasks/${t.id}/start`)}
									>
										Start
									</button>
									<button
										type="button"
										className="btn"
										onClick={() => void act(`/api/tasks/${t.id}/cancel`)}
										disabled={!t.running}
									>
										Abbrechen
									</button>
									<button type="button" className="btn danger" onClick={() => void remove(t.id)}>
										Löschen
									</button>
								</td>
							</tr>
						))}
						{tasks.length === 0 && (
							<tr>
								<td colSpan={5} className="muted">
									Noch keine Tasks.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{selected && (
				<div className="card">
					<div className="row between">
						<strong>Detail: {tasks.find((t) => t.id === selected)?.title ?? selected}</strong>
						<span className="muted">
							{detail?.executions.length ?? 0} Executions · {detail?.files.length ?? 0} Dateien
						</span>
					</div>

					{liveRuns.length > 0 && (
						<pre className="output live-cursor" style={{ marginTop: 10 }}>
							{liveRuns.map(([, run]) => run.text).join("")}
						</pre>
					)}
					{liveRuns.length > 0 && liveRuns.flatMap(([, r]) => r.failovers).length > 0 && (
						<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
							{liveRuns.flatMap(([, r]) => r.failovers).map((f) => `↻ ${f}`)}
						</div>
					)}

					{detail && detail.executions.length > 0 && (
						<table className="table" style={{ marginTop: 12 }}>
							<thead>
								<tr>
									<th>Status</th>
									<th>Tokens in/out</th>
									<th>tok/s</th>
									<th>Kosten</th>
									<th>Fehler</th>
								</tr>
							</thead>
							<tbody>
								{[...detail.executions].reverse().map((e) => (
									<tr key={e.id}>
										<td>
											<span className={`badge ${e.status}`}>{e.status}</span>
											{e.failoverCount > 0 && (
												<span className="badge" style={{ marginLeft: 4 }}>
													Failover #{e.failoverCount}
												</span>
											)}
										</td>
										<td>
											{e.tokensIn ?? 0} / {e.tokensOut ?? 0}
										</td>
										<td>{e.tpsAvg ?? "–"}</td>
										<td>{e.costUsd !== undefined ? `${e.costUsd.toFixed(4)} $` : "–"}</td>
										<td className="muted">{e.error ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}

					{detail && detail.files.length > 0 && (
						<div style={{ marginTop: 12 }}>
							<strong>Dateien (Workspace)</strong>
							<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
								{detail.files.map((f) => (
									<li key={f.relPath} className="mono">
										{f.relPath} <span className="muted">({f.size} B)</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{detail?.agentSelection && (
						<div style={{ marginTop: 12 }}>
							<strong>Spezialisten-Zuordnung</strong>
							<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
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
								<div className="row" style={{ marginTop: 6, gap: 8 }}>
									{[...detail.agentSelection.candidates]
										.sort((a, b) => b.score - a.score)
										.map((c) => (
											<span key={c.agentId} className="badge" style={{ opacity: c.score === 0 ? 0.55 : 1 }}>
												{c.name} · {c.score}
											</span>
										))}
								</div>
							)}
						</div>
					)}
					{detail && detail.decisions.length > 0 && (
						<div style={{ marginTop: 12 }}>
							<strong>Routing-Entscheidung (Explainability)</strong>
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
				<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
					Gewählt: <strong>{chosen.modelId}</strong> — Score {chosen.score}/100
				</div>
			)}
			<table className="table" style={{ marginTop: 6 }}>
				<thead>
					<tr>
						<th>Modell</th>
						<th>Score</th>
						{chosen?.axes.map((a) => (
							<th key={a.key}>{a.label}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{[...decision.candidates]
						.sort((a, b) => b.score - a.score)
						.map((c) => (
							<tr
								key={c.instanceId}
								style={{
									background:
										c.instanceId === decision.chosenInstanceId ? "rgba(79,140,255,0.08)" : undefined,
								}}
							>
								<td>
									{c.modelId}
									{c.instanceId === decision.chosenInstanceId && " ✓"}
								</td>
								<td>{c.score}</td>
								{chosen?.axes.map((a) => {
									const mine = c.axes.find((x) => x.key === a.key)
									return (
										<td key={a.key} className="muted">
											{mine ? `${(mine.value * 100).toFixed(0)}×${a.weight.toFixed(2)}` : "–"}
										</td>
									)
								})}
							</tr>
						))}
					{decision.excluded.map((x) => (
						<tr key={x.instanceId}>
							<td className="muted">{x.modelId} (ausgeschlossen)</td>
							<td>
								<span className="badge failed">−1</span>
							</td>
							<td colSpan={chosen?.axes.length ?? 1} className="muted">
								{x.reason}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
				Profil: est. {decision.profile.estTokens} Tokens · Privacy {decision.profile.privacy} · Modus{" "}
				{decision.profile.mode}
				{decision.profile.requiredCapabilities.length > 0 &&
					` · Pflicht: ${decision.profile.requiredCapabilities.join(", ")}`}
			</div>
		</div>
	)
}
