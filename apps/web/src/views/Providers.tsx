import type { InstanceModel, ModelSettings, ProviderType } from "@diriz/shared"
import { useState } from "react"
import SettingsEditor from "../components/SettingsEditor.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

const TYPES: ProviderType[] = ["ollama", "lmstudio", "openai-compat", "openrouter", "openai"]

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
	const [instSettings, setInstSettings] = useState<ModelSettings>({})
	const [instances, setInstances] = useState<InstanceModel[]>([])
	const [busySettings, setBusySettings] = useState(false)

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
			await refresh()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusySettings(false)
		}
	}

	const needsKey = type === "openrouter" || type === "openai"

	const addProvider = async () => {
		setBusy(true)
		try {
			await api.post("/api/providers", {
				type,
				label: label || type,
				baseUrl: needsKey && !baseUrl ? undefined : baseUrl,
				apiKey: needsKey ? apiKey : undefined,
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
								disabled={needsKey}
							/>
						</label>
						{needsKey && (
							<label className="field">
								API-Key
								<input
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="sk-…"
								/>
							</label>
						)}
						<button type="button" className="btn primary" onClick={() => void addProvider()} disabled={busy}>
							{busy ? "…" : "Speichern"}
						</button>
					</div>
					<p className="muted" style={{ marginBottom: 0 }}>
						API-Keys werden verschlüsselt in <code>~/.diriz</code> gespeichert und nie zurückgegeben.
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
							<strong>Modell-Overrides</strong>
							<div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
								Pro Modell einzelne Werte überschreiben (z. B. Kontext- oder Temperatur-Anpassung je Modell).
							</div>
							<div style={{ marginTop: 8 }}>
								{instances.map((inst) => (
									<div key={inst.id} style={{ marginTop: 8 }}>
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
											{inst.modelSettings && Object.keys(inst.modelSettings).length > 0
												? " — Overrides ✓"
												: " — ohne Overrides"}
										</button>
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
