import type { Capability, InstanceModel, ModelSettings, ProviderType } from "@diriz/shared"
import { type CSSProperties, useState } from "react"
import DocsEditor from "../components/DocsEditor.js"
import {
	IconAlert,
	IconClose,
	IconDoc,
	IconEdit,
	IconHeart,
	IconKey,
	IconPlus,
	IconRadar,
	IconServer,
	IconSettings,
	IconTrash,
} from "../components/icons.js"
import SettingsEditor from "../components/SettingsEditor.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

const TYPES: ProviderType[] = ["ollama", "lmstudio", "openai-compat", "openrouter", "openai"]
const CAPABILITIES: Capability[] = ["code", "reasoning", "longform", "vision", "tools", "json"]

/** Entwurf beim Bearbeiten eines Providers (Rechner). */
interface ProviderDraft {
	label: string
	baseUrl: string
	apiKey: string
	clearApiKey: boolean
	enabled: boolean
}

/** Entwurf beim Bearbeiten eines Modells (Instance). */
interface InstanceDraft {
	displayName: string
	contextWindow: string
	capabilities: Capability[]
	languages: string
	priceIn: string
	priceOut: string
}

function instanceDraft(inst: InstanceModel): InstanceDraft {
	return {
		displayName: inst.displayName,
		contextWindow: String(inst.contextWindow ?? ""),
		capabilities: [...inst.capabilities],
		languages: inst.languages.join(", "),
		priceIn: inst.pricePerMTok ? String(inst.pricePerMTok.in) : "",
		priceOut: inst.pricePerMTok ? String(inst.pricePerMTok.out) : "",
	}
}

export default function Providers() {
	const providers = useStore((s) => s.providers)
	const refresh = useStore((s) => s.refreshProviders)
	const setLastError = useStore((s) => s.setLastError)

	const [showForm, setShowForm] = useState(false)
	const [type, setType] = useState<ProviderType>("ollama")
	const [label, setLabel] = useState("")
	const [baseUrl, setBaseUrl] = useState("http://localhost:11434")
	const [apiKey, setApiKey] = useState("")
	const [busy, setBusy] = useState(false)

	// Model-Settings (pro Rechner) + Modell-Overrides.
	const [expanded, setExpanded] = useState<string | null>(null)
	const [settings, setSettings] = useState<ModelSettings>({})
	const [instExpanded, setInstExpanded] = useState<string | null>(null)
	/** Offener Dokument-Editor (plan/changelog/init.md) einer LLM-Instanz. */
	const [instDocs, setInstDocs] = useState<string | null>(null)
	const [instSettings, setInstSettings] = useState<ModelSettings>({})
	const [instances, setInstances] = useState<InstanceModel[]>([])
	const [busySettings, setBusySettings] = useState(false)

	// Bearbeiten: Provider (Rechner) und Modelle (Instances).
	const [editProvider, setEditProvider] = useState<string | null>(null)
	const [pDraft, setPDraft] = useState<ProviderDraft | null>(null)
	const [editInstance, setEditInstance] = useState<string | null>(null)
	const [iDraft, setIDraft] = useState<InstanceDraft | null>(null)

	const openSettings = async (p: (typeof providers)[number]) => {
		if (expanded === p.id) {
			setExpanded(null)
			return
		}
		setExpanded(p.id)
		setSettings({ ...p.modelSettings })
		setInstExpanded(null)
		try {
			const data = await api.get<{ instances?: InstanceModel[] }>(`/api/providers/${p.id}`)
			setInstances(data.instances ?? [])
		} catch {
			setInstances([])
		}
	}

	const startEditProvider = (p: (typeof providers)[number]) => {
		if (editProvider === p.id) {
			setEditProvider(null)
			return
		}
		setEditProvider(p.id)
		setPDraft({ label: p.label, baseUrl: p.baseUrl, apiKey: "", clearApiKey: false, enabled: p.enabled })
	}

	const saveProvider = async () => {
		if (!editProvider || !pDraft) return
		setBusySettings(true)
		try {
			await api.patch(`/api/providers/${editProvider}`, {
				label: pDraft.label,
				baseUrl: pDraft.baseUrl,
				enabled: pDraft.enabled,
				apiKey: pDraft.apiKey || undefined,
				clearApiKey: pDraft.clearApiKey || undefined,
			})
			setEditProvider(null)
			setPDraft(null)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const startEditInstance = (inst: InstanceModel) => {
		if (editInstance === inst.id) {
			setEditInstance(null)
			return
		}
		setEditInstance(inst.id)
		setIDraft(instanceDraft(inst))
	}

	const saveInstance = async (instId: string) => {
		if (!iDraft) return
		setBusySettings(true)
		try {
			const priceIn = Number(iDraft.priceIn)
			const priceOut = Number(iDraft.priceOut)
			await api.patch(`/api/instances/${instId}`, {
				displayName: iDraft.displayName,
				contextWindow: iDraft.contextWindow ? Number(iDraft.contextWindow) : undefined,
				capabilities: iDraft.capabilities,
				languages: iDraft.languages
					.split(",")
					.map((x) => x.trim())
					.filter(Boolean),
				priceInPerMTok: iDraft.priceIn && Number.isFinite(priceIn) ? priceIn : undefined,
				priceOutPerMTok: iDraft.priceOut && Number.isFinite(priceOut) ? priceOut : undefined,
			})
			setEditInstance(null)
			setIDraft(null)
			if (expanded) await reloadInstances(expanded)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const saveSettings = async () => {
		if (!expanded) return
		setBusySettings(true)
		try {
			await api.patch(`/api/providers/${expanded}`, { modelSettings: settings })
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const saveInstSettings = async (instId: string) => {
		setBusySettings(true)
		try {
			await api.patch(`/api/instances/${instId}`, { modelSettings: instSettings })
			if (expanded) await reloadInstances(expanded)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const clearInstSettings = async (instId: string) => {
		setBusySettings(true)
		try {
			await api.patch(`/api/instances/${instId}`, { modelSettings: null })
			if (expanded) await reloadInstances(expanded)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const reloadInstances = async (providerId: string) => {
		try {
			const data = await api.get<{ instances?: InstanceModel[] }>(`/api/providers/${providerId}`)
			setInstances(data.instances ?? [])
		} catch {
			/* alte Liste behalten */
		}
	}

	const isActive = (inst: InstanceModel) => inst.enabled !== false

	/** Modell pro Rechner aktivieren/deaktivieren (Routing-Gate). */
	const toggleEnabled = async (inst: InstanceModel, enabled: boolean) => {
		// Optimistisch aktualisieren, damit die UI sofort reagiert.
		setInstances((prev) => prev.map((i) => (i.id === inst.id ? { ...i, enabled } : i)))
		try {
			await api.patch(`/api/instances/${inst.id}`, { enabled })
			if (expanded) await reloadInstances(expanded)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
			if (expanded) await reloadInstances(expanded) // auf Server-Zustand zurückrollen
		}
	}

	const requiresKey = type === "openrouter" || type === "openai"

	const addProvider = async () => {
		setBusy(true)
		try {
			await api.post("/api/providers", {
				type,
				label: label || type,
				baseUrl: requiresKey && !baseUrl ? undefined : baseUrl,
				apiKey: apiKey || undefined,
			})
			setLabel("")
			setApiKey("")
			setShowForm(false)
			await refresh()
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
			await api.del(`/api/providers/${id}`)
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const onlineCount = providers.filter((p) => p.status === "online").length

	return (
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Provider</h1>
					<p className="page-sub">
						Rechner und Endpunkte, auf denen Modelle laufen — lokal (Ollama, LM Studio) oder in der Cloud.
					</p>
				</div>
				<div className="page-actions">
					{providers.length > 0 && (
						<span className="pill ok no-dot">
							{onlineCount}/{providers.length} online
						</span>
					)}
					<button
						type="button"
						className="btn primary"
						onClick={() => setShowForm((v) => !v)}
						aria-expanded={showForm}
					>
						{showForm ? <IconClose size={15} /> : <IconPlus size={15} />}
						{showForm ? "Abbrechen" : "Provider verbinden"}
					</button>
				</div>
			</div>

			{showForm && (
				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">
								<IconPlus size={16} />
								Neuer Provider
							</div>
							<div className="card-sub">
								Nach dem Speichern prüft DiriZ die Erreichbarkeit und entdeckt die verfügbaren Modelle
								automatisch.
							</div>
						</div>
					</div>
					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field">
							Typ
							<select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
								{TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							Name
							<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={type} />
						</label>
						<label className="field grow">
							Base URL
							<input
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder={type === "ollama" ? "http://localhost:11434" : "https://…/v1"}
								disabled={requiresKey}
							/>
						</label>
						<label className="field">
							API-Key {requiresKey ? "*" : "(optional)"}
							<input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="sk-… / Bearer-Token"
							/>
						</label>
						<button type="button" className="btn primary" onClick={() => void addProvider()} disabled={busy}>
							{busy ? "Speichere …" : "Speichern"}
						</button>
					</div>
					<p className="hint" style={{ marginTop: 12 }}>
						<IconKey size={14} />
						<span>
							Der API-Key wird als Bearer-Token gesendet (<code>Authorization: Bearer …</code>) und
							verschlüsselt in <code>~/.diriz</code> gespeichert — er wird nie wieder ausgegeben.
						</span>
					</p>
				</div>
			)}

			<div className="card">
				<div className="table-wrap">
					<table className="table">
						<thead>
							<tr>
								<th>Name</th>
								<th>Typ / URL</th>
								<th>Status</th>
								<th className="num">Modelle</th>
								<th className="num">Latenz p50/p95</th>
								<th className="actions-cell">Aktionen</th>
							</tr>
						</thead>
						<tbody>
							{providers.map((p) => (
								<tr key={p.id} className={expanded === p.id || editProvider === p.id ? "selected" : ""}>
									<td>
										<div className="cell-title">
											<strong>{p.label}</strong>
											{p.hasApiKey && (
												<span className="badge" title="API-Key hinterlegt">
													<IconKey size={11} />
													Key
												</span>
											)}
											{!p.enabled && <span className="badge subtle">inaktiv</span>}
											{/* Wo die Modelle dieses Zugangs wirklich rechnen. Bei LM Studio
											    mit „LM Link" ist das nicht zwingend der Rechner des Endpunkts:
											    Ein Mac kann die Modelle eines Windows-Rechners durchreichen. */}
											{p.devices?.map((d) => (
												<span
													key={d}
													className="badge subtle"
													title={`Modelle dieses Zugangs rechnen auf „${d}". Der GPU-Schutz zählt pro Rechner, nicht pro Zugang.`}
												>
													<IconServer size={11} />
													{d}
												</span>
											))}
											{p.sameMachineAs && p.sameMachineAs.length > 0 && (
												<span
													className="badge subtle"
													title={`Führt exakt dieselben Modelle wie ${p.sameMachineAs.join(", ")} — vermutlich ein zweiter Zugang zum selben LM Studio.`}
												>
													= {p.sameMachineAs.join(", ")}
												</span>
											)}
										</div>
									</td>
									<td>
										<span className="muted">{p.type}</span>
										<div className="cell-meta mono">{p.baseUrl}</div>
									</td>
									<td>
										<span className={`pill ${p.status}`}>{p.status}</span>
									</td>
									<td className="num">{p.instanceCount ?? 0}</td>
									<td className="num">
										{p.latencyP50 !== undefined ? `${p.latencyP50} / ${p.latencyP95 ?? "–"} ms` : "–"}
									</td>
									<td className="actions-cell">
										<div className="actions">
											<button
												type="button"
												className={`icon-btn ${editProvider === p.id ? "active" : ""}`}
												aria-label={`${p.label} bearbeiten`}
												title="Bearbeiten"
												onClick={() => startEditProvider(p)}
											>
												<IconEdit size={16} />
											</button>
											<button
												type="button"
												className="icon-btn"
												aria-label={`Health-Check für ${p.label}`}
												title="Health-Check ausführen"
												onClick={() => void act(`/api/providers/${p.id}/health`)}
											>
												<IconHeart size={16} />
											</button>
											<button
												type="button"
												className="icon-btn"
												aria-label={`Modelle von ${p.label} entdecken`}
												title="Modelle entdecken"
												onClick={() => void act(`/api/providers/${p.id}/discover`)}
											>
												<IconRadar size={16} />
											</button>
											<button
												type="button"
												className={`icon-btn ${expanded === p.id ? "active" : ""}`}
												aria-label={`Model-Settings von ${p.label}`}
												title="Model-Settings & Modelle"
												onClick={() => void openSettings(p)}
											>
												<IconSettings size={16} />
											</button>
											<button
												type="button"
												className="icon-btn danger"
												aria-label={`${p.label} entfernen`}
												title="Entfernen"
												onClick={() => void remove(p.id)}
											>
												<IconTrash size={16} />
											</button>
										</div>
									</td>
								</tr>
							))}
							{providers.length === 0 && (
								<tr>
									<td colSpan={6}>
										<div className="empty">
											<span className="icon-chip lg" style={{ "--mc": "var(--accent)" } as CSSProperties}>
												<IconServer size={20} />
											</span>
											<span className="empty-title">Noch kein Provider verbunden</span>
											<p>
												Verbinde deinen ersten Rechner — z. B. ein lokales Ollama unter{" "}
												<code>http://localhost:11434</code>.
											</p>
											<button type="button" className="btn primary" onClick={() => setShowForm(true)}>
												<IconPlus size={15} />
												Provider verbinden
											</button>
										</div>
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{editProvider && pDraft && (
				<div className="card">
					<div className="card-head">
						<div className="card-title">
							<IconEdit size={16} />
							Rechner bearbeiten: {providers.find((x) => x.id === editProvider)?.label}
						</div>
						<button
							type="button"
							className="icon-btn"
							aria-label="Bearbeiten schließen"
							onClick={() => setEditProvider(null)}
						>
							<IconClose size={16} />
						</button>
					</div>
					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field" style={{ minWidth: 170 }}>
							Name
							<input value={pDraft.label} onChange={(e) => setPDraft({ ...pDraft, label: e.target.value })} />
						</label>
						<label className="field grow">
							Base URL
							<input
								value={pDraft.baseUrl}
								onChange={(e) => setPDraft({ ...pDraft, baseUrl: e.target.value })}
								placeholder="http://localhost:11434"
							/>
						</label>
						<label className="field" style={{ minWidth: 210 }}>
							API-Key ersetzen
							<input
								type="password"
								value={pDraft.apiKey}
								onChange={(e) => setPDraft({ ...pDraft, apiKey: e.target.value, clearApiKey: false })}
								placeholder="leer = unverändert"
							/>
						</label>
						<label className="check">
							<input
								type="checkbox"
								checked={pDraft.clearApiKey}
								onChange={(e) => setPDraft({ ...pDraft, clearApiKey: e.target.checked, apiKey: "" })}
							/>
							Key entfernen
						</label>
						<label className="check">
							<input
								type="checkbox"
								checked={pDraft.enabled}
								onChange={(e) => setPDraft({ ...pDraft, enabled: e.target.checked })}
							/>
							aktiv
						</label>
					</div>
					<div className="row" style={{ marginTop: 14 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void saveProvider()}
							disabled={busySettings || pDraft.label.trim().length === 0}
						>
							{busySettings ? "Speichere …" : "Speichern"}
						</button>
						<button type="button" className="btn ghost" onClick={() => setEditProvider(null)}>
							Abbrechen
						</button>
						<span className="hint">
							<IconAlert size={14} />
							Nach dem Speichern werden Adapter, Health-Check und Discovery neu aufgesetzt.
						</span>
					</div>
				</div>
			)}

			{expanded && (
				<div className="card">
					<div className="card-head">
						<div>
							<div className="card-title">
								<IconSettings size={16} />
								Model-Settings: {providers.find((x) => x.id === expanded)?.label}
							</div>
							<div className="card-sub">
								Gilt für alle Modelle auf diesem Rechner. Reihenfolge: <strong>Provider-Default</strong> →
								Modell-Override → Task-Override (der spätere gewinnt).
							</div>
						</div>
						<button
							type="button"
							className="icon-btn"
							aria-label="Model-Settings schließen"
							onClick={() => setExpanded(null)}
						>
							<IconClose size={16} />
						</button>
					</div>

					<div style={{ marginTop: 14 }}>
						<SettingsEditor value={settings} onChange={setSettings} />
					</div>
					<div className="row" style={{ marginTop: 14 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void saveSettings()}
							disabled={busySettings}
						>
							{busySettings ? "Speichere …" : "Speichern"}
						</button>
						<button type="button" className="btn ghost" onClick={() => setSettings({})}>
							Zurücksetzen
						</button>
					</div>

					{instances.length > 0 && (
						<>
							<div className="divider" />
							<div className="card-title">Modelle auf diesem Rechner</div>
							<div className="card-sub">
								Modelle aktivieren/deaktivieren, einzelne Werte überschreiben und die Dokumente (
								<code>plan.md</code>, <code>init.md</code>) pflegen. Deaktivierte Modelle nutzt das Routing
								nicht.
							</div>
							<div className="stack" style={{ marginTop: 12 }}>
								{instances.map((inst) => {
									const overrides = Object.keys(inst.modelSettings ?? {}).length
									return (
										<div key={inst.id} style={{ opacity: isActive(inst) ? 1 : 0.55 }}>
											<div className="row" style={{ gap: 10 }}>
												<label
													className="check"
													title={
														isActive(inst)
															? "Modell ist aktiv — das Routing darf es nutzen."
															: "Modell deaktiviert — das Routing nutzt es nicht."
													}
												>
													<input
														type="checkbox"
														checked={isActive(inst)}
														onChange={(e) => void toggleEnabled(inst, e.target.checked)}
													/>
													aktiv
												</label>
												<button
													type="button"
													className="linklike grow"
													onClick={() => {
														if (instExpanded === inst.id) {
															setInstExpanded(null)
														} else {
															setInstExpanded(inst.id)
															setInstSettings({ ...inst.modelSettings })
														}
													}}
												>
													<strong>{inst.displayName}</strong>{" "}
													{overrides > 0 ? (
														<span className="badge accent">{overrides} Overrides</span>
													) : (
														<span className="badge subtle">ohne Overrides</span>
													)}
												</button>
												<div className="actions">
													<button
														type="button"
														className={`icon-btn ${editInstance === inst.id ? "active" : ""}`}
														aria-label={`${inst.displayName} bearbeiten`}
														title="Modell bearbeiten"
														onClick={() => startEditInstance(inst)}
													>
														<IconEdit size={16} />
													</button>
													<button
														type="button"
														className={`icon-btn ${instDocs === inst.id ? "active" : ""}`}
														aria-label={`Datenblatt von ${inst.displayName}`}
														title="llm.md — das Datenblatt dieses Modells (Fähigkeiten, Stärken, Werkzeuge, Voreinstellungen)"
														onClick={() => setInstDocs(instDocs === inst.id ? null : inst.id)}
													>
														<IconDoc size={16} />
													</button>
													<button
														type="button"
														className={`icon-btn ${instExpanded === inst.id ? "active" : ""}`}
														aria-label={`Overrides für ${inst.displayName}`}
														title="Model-Settings dieses Modells"
														onClick={() => {
															if (instExpanded === inst.id) {
																setInstExpanded(null)
															} else {
																setInstExpanded(inst.id)
																setInstSettings({ ...inst.modelSettings })
															}
														}}
													>
														<IconSettings size={16} />
													</button>
												</div>
											</div>

											{editInstance === inst.id && iDraft && (
												<div className="subpanel">
													<div className="row" style={{ alignItems: "flex-end" }}>
														<label className="field" style={{ minWidth: 180 }}>
															Anzeigename
															<input
																value={iDraft.displayName}
																onChange={(e) => setIDraft({ ...iDraft, displayName: e.target.value })}
															/>
														</label>
														<label className="field">
															Kontext-Fenster (Tokens)
															<input
																type="number"
																min={1}
																value={iDraft.contextWindow}
																onChange={(e) => setIDraft({ ...iDraft, contextWindow: e.target.value })}
															/>
														</label>
														<label className="field" style={{ minWidth: 160 }}>
															Sprachen (kommagetrennt)
															<input
																value={iDraft.languages}
																onChange={(e) => setIDraft({ ...iDraft, languages: e.target.value })}
																placeholder="de, en"
															/>
														</label>
														<label className="field">
															Preis in $/M Tok
															<input
																type="number"
																step="0.01"
																min={0}
																value={iDraft.priceIn}
																onChange={(e) => setIDraft({ ...iDraft, priceIn: e.target.value })}
																placeholder="—"
															/>
														</label>
														<label className="field">
															Preis out $/M Tok
															<input
																type="number"
																step="0.01"
																min={0}
																value={iDraft.priceOut}
																onChange={(e) => setIDraft({ ...iDraft, priceOut: e.target.value })}
																placeholder="—"
															/>
														</label>
													</div>
													<div style={{ marginTop: 12 }}>
														<div className="field-hint" style={{ marginBottom: 6 }}>
															Fähigkeiten
														</div>
														<div className="chip-group">
															{CAPABILITIES.map((c) => (
																<label key={c} className="check-chip">
																	<input
																		type="checkbox"
																		checked={iDraft.capabilities.includes(c)}
																		onChange={() =>
																			setIDraft({
																				...iDraft,
																				capabilities: iDraft.capabilities.includes(c)
																					? iDraft.capabilities.filter((x) => x !== c)
																					: [...iDraft.capabilities, c],
																			})
																		}
																	/>
																	{c}
																</label>
															))}
														</div>
													</div>
													<div className="row" style={{ marginTop: 12 }}>
														<button
															type="button"
															className="btn primary"
															onClick={() => void saveInstance(inst.id)}
															disabled={busySettings}
														>
															Speichern
														</button>
														<button type="button" className="btn ghost" onClick={() => setEditInstance(null)}>
															Abbrechen
														</button>
													</div>
												</div>
											)}

											{instExpanded === inst.id && (
												<div className="subpanel">
													<SettingsEditor value={instSettings} onChange={setInstSettings} />
													<div className="row" style={{ marginTop: 12 }}>
														<button
															type="button"
															className="btn primary"
															onClick={() => void saveInstSettings(inst.id)}
															disabled={busySettings}
														>
															Speichern
														</button>
														<button
															type="button"
															className="btn danger"
															onClick={() => void clearInstSettings(inst.id)}
															disabled={busySettings}
														>
															<IconTrash size={15} />
															Overrides löschen
														</button>
													</div>
												</div>
											)}

											{instDocs === inst.id && (
												<div className="subpanel">
													<DocsEditor
														ownerKind="instance"
														basePath={`/api/instances/${inst.id}`}
														ownerName={inst.displayName}
														onEffectiveSaved={async () => {
															if (expanded) await reloadInstances(expanded)
														}}
														onClose={() => setInstDocs(null)}
													/>
												</div>
											)}
										</div>
									)
								})}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	)
}
