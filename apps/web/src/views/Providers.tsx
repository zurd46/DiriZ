import type { Capability, InstanceModel, ModelSettings, ProviderType } from "@diriz/shared"
import { useState } from "react"
import DocsEditor from "../components/DocsEditor.js"
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

	return (
		<div>
			<div className="row between">
				<h1>Provider</h1>
				<button type="button" className="btn primary" onClick={() => setShowForm((v) => !v)}>
					+ Provider verbinden
				</button>
			</div>

			{showForm && (
				<div className="card">
					<div className="row">
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
						<label className="field">
							Base URL
							<input
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder={type === "ollama" ? "http://localhost:11434" : "https://…/v1"}
								disabled={requiresKey}
							/>
						</label>
						<label className="field">
							API-Key {requiresKey ? "" : "(optional)"}
							<input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="sk-… / Bearer-Token"
							/>
						</label>
						<button type="button" className="btn primary" onClick={() => void addProvider()} disabled={busy}>
							{busy ? "…" : "Speichern"}
						</button>
					</div>
					<p className="muted" style={{ marginBottom: 0 }}>
						API-Key wird als Bearer-Token gesendet (<code>Authorization: Bearer …</code>) und verschlüsselt in{" "}
						<code>~/.diriz</code> gespeichert — nie zurückgegeben.
					</p>
				</div>
			)}

			<div className="card">
				<table className="table">
					<thead>
						<tr>
							<th>Name</th>
							<th>Typ / URL</th>
							<th>Status</th>
							<th>Modelle</th>
							<th>Latenz p50/p95</th>
							<th>Aktionen</th>
						</tr>
					</thead>
					<tbody>
						{providers.map((p) => (
							<tr key={p.id}>
								<td>
									<strong>{p.label}</strong>
									{p.hasApiKey && (
										<span className="badge" style={{ marginLeft: 6 }}>
											Key
										</span>
									)}
								</td>
								<td className="muted">
									{p.type}
									<br />
									<span className="mono">{p.baseUrl}</span>
								</td>
								<td>
									<span className={`dot ${p.status}`} /> {p.status}
								</td>
								<td>{p.instanceCount ?? 0}</td>
								<td>{p.latencyP50 !== undefined ? `${p.latencyP50} / ${p.latencyP95 ?? "–"} ms` : "–"}</td>
								<td className="row">
									<button
										type="button"
										className={`btn ${editProvider === p.id ? "primary" : ""}`}
										onClick={() => startEditProvider(p)}
									>
										✏️ Bearbeiten
									</button>
									<button
										type="button"
										className="btn"
										onClick={() => void act(`/api/providers/${p.id}/health`)}
									>
										Health
									</button>
									<button
										type="button"
										className="btn"
										onClick={() => void act(`/api/providers/${p.id}/discover`)}
									>
										Entdecken
									</button>
									<button
										type="button"
										className={`btn ${expanded === p.id ? "primary" : ""}`}
										onClick={() => void openSettings(p)}
									>
										⚙ Settings
									</button>
									<button type="button" className="btn danger" onClick={() => void remove(p.id)}>
										Entfernen
									</button>
								</td>
							</tr>
						))}
						{providers.length === 0 && (
							<tr>
								<td colSpan={6} className="muted">
									Noch keine Provider verbunden.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{editProvider && pDraft && (
				<div className="card">
					<div className="row between">
						<strong>✏️ Rechner bearbeiten: {providers.find((x) => x.id === editProvider)?.label}</strong>
						<button type="button" className="btn" onClick={() => setEditProvider(null)}>
							Schließen
						</button>
					</div>
					<div className="row" style={{ marginTop: 8 }}>
						<label className="field" style={{ minWidth: 160 }}>
							Name
							<input value={pDraft.label} onChange={(e) => setPDraft({ ...pDraft, label: e.target.value })} />
						</label>
						<label className="field" style={{ flex: 1, minWidth: 240 }}>
							Base URL
							<input
								value={pDraft.baseUrl}
								onChange={(e) => setPDraft({ ...pDraft, baseUrl: e.target.value })}
								placeholder="http://localhost:11434"
							/>
						</label>
						<label className="field" style={{ minWidth: 200 }}>
							API-Key ersetzen (leer = unverändert)
							<input
								type="password"
								value={pDraft.apiKey}
								onChange={(e) => setPDraft({ ...pDraft, apiKey: e.target.value, clearApiKey: false })}
								placeholder="sk-… / Bearer-Token"
							/>
						</label>
						<label className="muted" style={{ fontSize: 13 }}>
							<input
								type="checkbox"
								checked={pDraft.clearApiKey}
								onChange={(e) => setPDraft({ ...pDraft, clearApiKey: e.target.checked, apiKey: "" })}
							/>
							Key entfernen
						</label>
						<label className="muted" style={{ fontSize: 13 }}>
							<input
								type="checkbox"
								checked={pDraft.enabled}
								onChange={(e) => setPDraft({ ...pDraft, enabled: e.target.checked })}
							/>
							aktiv
						</label>
					</div>
					<div className="row" style={{ marginTop: 10 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void saveProvider()}
							disabled={busySettings || pDraft.label.trim().length === 0}
						>
							{busySettings ? "…" : "Speichern"}
						</button>
						<button type="button" className="btn" onClick={() => setEditProvider(null)}>
							Abbrechen
						</button>
					</div>
					<p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
						Nach dem Speichern werden Adapter, Health-Check und Discovery neu aufgesetzt.
					</p>
				</div>
			)}

			{expanded && (
				<div className="card">
					<div className="row between">
						<strong>⚙ Model-Settings: {providers.find((x) => x.id === expanded)?.label}</strong>
						<button type="button" className="btn" onClick={() => setExpanded(null)}>
							Schließen
						</button>
					</div>
					<p className="muted" style={{ marginTop: 4 }}>
						Gilt für alle Modelle auf diesem Rechner. Reihenfolge: <strong>Provider-Default</strong> ←
						Modell-Override ← Task-Override.
					</p>
					<SettingsEditor value={settings} onChange={setSettings} />
					<div className="row" style={{ marginTop: 10 }}>
						<button
							type="button"
							className="btn primary"
							onClick={() => void saveSettings()}
							disabled={busySettings}
						>
							{busySettings ? "…" : "Speichern"}
						</button>
						<button type="button" className="btn" onClick={() => setSettings({})}>
							Zurücksetzen
						</button>
					</div>

					{instances.length > 0 && (
						<div style={{ marginTop: 14 }}>
							<strong>Modelle (pro Rechner)</strong>
							<div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
								Modelle aktivieren/deaktivieren und pro Modell einzelne Werte überschreiben (z. B. Kontext-
								oder Temperatur-Anpassung). Deaktivierte Modelle nutzt das Routing nicht.
							</div>
							<div style={{ marginTop: 8 }}>
								{instances.map((inst) => (
									<div key={inst.id} style={{ marginTop: 8, opacity: isActive(inst) ? 1 : 0.55 }}>
										<div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
											<label
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 6,
													cursor: "pointer",
													fontSize: 13,
												}}
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
											<button type="button" className="btn" onClick={() => startEditInstance(inst)}>
												✏️ Bearbeiten
											</button>
											<button
												type="button"
												className="btn"
												title="plan.md, changelog.md und init.md dieser LLM-Instanz"
												onClick={() => setInstDocs(instDocs === inst.id ? null : inst.id)}
											>
												📄 Dokumente
											</button>
											<button
												type="button"
												className="linklike"
												onClick={() => {
													if (instExpanded === inst.id) {
														setInstExpanded(null)
													} else {
														setInstExpanded(inst.id)
														setInstSettings({ ...inst.modelSettings })
													}
												}}
											>
												<strong>{inst.displayName}</strong>
												{!isActive(inst)
													? " — deaktiviert"
													: inst.modelSettings && Object.keys(inst.modelSettings).length > 0
														? " — Overrides ✓"
														: " — ohne Overrides"}
											</button>
										</div>
										{editInstance === inst.id && iDraft && (
											<div style={{ marginTop: 6, paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
												<div className="row">
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
												<div className="row" style={{ marginTop: 6 }}>
													<span className="muted" style={{ fontSize: 12 }}>
														Fähigkeiten:
													</span>
													{CAPABILITIES.map((c) => (
														<label key={c} className="muted" style={{ fontSize: 13 }}>
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
												<div className="row" style={{ marginTop: 8 }}>
													<button
														type="button"
														className="btn primary"
														onClick={() => void saveInstance(inst.id)}
														disabled={busySettings}
													>
														Speichern
													</button>
													<button type="button" className="btn" onClick={() => setEditInstance(null)}>
														Abbrechen
													</button>
												</div>
											</div>
										)}
										{instExpanded === inst.id && (
											<div style={{ marginTop: 6, paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
												<SettingsEditor value={instSettings} onChange={setInstSettings} />
												<div className="row" style={{ marginTop: 8 }}>
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
														onClick={() => void clearInstSettings(inst.id)}
														disabled={busySettings}
													>
														Overrides löschen
													</button>
												</div>
											</div>
										)}
										{instDocs === inst.id && (
											<div style={{ paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
												<DocsEditor
													basePath={`/api/instances/${inst.id}`}
													ownerName={inst.displayName}
													onInitSaved={async () => {
														if (expanded) await reloadInstances(expanded)
													}}
													onClose={() => setInstDocs(null)}
												/>
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
