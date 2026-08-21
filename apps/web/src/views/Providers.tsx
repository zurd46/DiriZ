import type { ProviderType } from "@diriz/shared"
import { useState } from "react"
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
		</div>
	)
}
