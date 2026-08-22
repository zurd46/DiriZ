/**
 * Einstellungen (M7): Routing-Gewichte, Daten-Export/-Import, Info.
 */

import { DEFAULT_WEIGHTS, normalizeWeights, type ScoringWeights } from "@diriz/shared"
import { useEffect, useRef, useState } from "react"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

const WEIGHT_META: { key: keyof ScoringWeights; label: string; hint: string }[] = [
	{ key: "contextFit", label: "Context-Fit", hint: "Passt das Context-Fenster zur Task?" },
	{ key: "capabilityMatch", label: "Capability-Match", hint: "Erfüllte Modell-Fähigkeiten" },
	{ key: "qualityPrior", label: "Qualitäts-Prior", hint: "Lernfähige Erfolgshistorie (Ratings)" },
	{ key: "loadScore", label: "Last", hint: "Aktuelle Auslastung des Providers" },
	{ key: "costScore", label: "Kosten", hint: "Preis pro Token (lokal = 0 $)" },
	{ key: "latencyScore", label: "Latenz", hint: "Antwortgeschwindigkeit" },
	{
		key: "hostLoad",
		label: "Host-Last",
		hint: "RAM-Belegung dieses Rechners — bestraft lokale Modelle bei hoher Last (0 = aus)",
	},
]

export default function Settings() {
	const settings = useStore((s) => s.settings)
	const lastError = useStore((s) => s.lastError)
	const [draft, setDraft] = useState<ScoringWeights | null>(null)
	const [saved, setSaved] = useState(false)
	const [busy, setBusy] = useState(false)
	const [importMsg, setImportMsg] = useState<string | undefined>()
	const fileRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (settings && draft === null) {
			setDraft(settings.routingWeights)
		}
	}, [settings, draft])

	const normalized = draft ? normalizeWeights(draft) : null
	const dirty =
		draft !== null &&
		settings !== null &&
		JSON.stringify(normalizeWeights(draft)) !== JSON.stringify(settings.routingWeights)

	const save = async () => {
		if (!draft) return
		setBusy(true)
		const ok = await useStore.getState().saveSettings(draft)
		setBusy(false)
		setSaved(ok)
		setTimeout(() => setSaved(false), 2500)
	}

	const exportData = async () => {
		try {
			const data = await api.get<unknown>("/api/export")
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
			const url = URL.createObjectURL(blob)
			const a = document.createElement("a")
			a.href = url
			a.download = `diriz-export-${new Date().toISOString().slice(0, 10)}.json`
			a.click()
			URL.revokeObjectURL(url)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		}
	}

	const importData = async (file: File) => {
		try {
			const text = await file.text()
			const result = await api.post<{ imported: number; tasks: number }>("/api/import", JSON.parse(text))
			setImportMsg(
				`Importiert: ${result.imported} Einträge (${result.tasks} Tasks im Export, nicht überschrieben)`,
			)
			void useStore.getState().refreshAgents()
			void useStore.getState().refreshSwarms()
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			if (fileRef.current) fileRef.current.value = ""
		}
	}

	return (
		<div>
			<h1>Einstellungen</h1>
			{lastError && <div className="error-banner">{lastError}</div>}

			<div className="card">
				<strong>Routing-Gewichte</strong>
				<p className="muted" style={{ margin: "6px 0 14px", fontSize: 13 }}>
					Steuert, wie DiriZ das beste Modell auswählt. Gewichte werden automatisch renormiert (Summe = 1).
				</p>
				{draft &&
					normalized &&
					WEIGHT_META.map((w) => (
						<div key={w.key} style={{ marginBottom: 14 }}>
							<div className="row between" style={{ fontSize: 13 }}>
								<span title={w.hint}>
									{w.label} <span className="muted">· {Math.round((normalized[w.key] ?? 0) * 100)}%</span>
								</span>
								<span className="mono muted">{(draft[w.key] ?? 0).toFixed(2)}</span>
							</div>
							<input
								type="range"
								min={0}
								max={1}
								step={0.01}
								value={draft[w.key]}
								onChange={(e) => setDraft({ ...draft, [w.key]: Number(e.target.value) })}
								style={{ width: "100%", accentColor: "var(--accent)" }}
								aria-label={w.label}
							/>
						</div>
					))}
				<div className="row" style={{ gap: 8 }}>
					<button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
						Speichern
					</button>
					<button type="button" className="btn" onClick={() => setDraft({ ...DEFAULT_WEIGHTS })}>
						Defaults wiederherstellen
					</button>
					{saved && (
						<span style={{ color: "var(--ok)", fontSize: 13 }}>
							✓ Gespeichert — gilt ab der nächsten Task.
						</span>
					)}
				</div>
			</div>

			<div className="card">
				<strong>Daten</strong>
				<p className="muted" style={{ margin: "6px 0 14px", fontSize: 13 }}>
					Export/Import von Agenten, Swarms, Templates und Settings. Provider &amp; API-Keys werden bewusst
					nicht exportiert.
				</p>
				<div className="row" style={{ gap: 8 }}>
					<button type="button" className="btn" onClick={() => void exportData()}>
						⬇ Export (JSON)
					</button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						hidden
						onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])}
					/>
					<button type="button" className="btn" onClick={() => fileRef.current?.click()}>
						⬆ Import (JSON)
					</button>
				</div>
				{importMsg && <p style={{ marginTop: 10, fontSize: 13 }}>{importMsg}</p>}
			</div>

			<div className="card">
				<strong>Über DiriZ</strong>
				<table className="table" style={{ marginTop: 8 }}>
					<tbody>
						<tr>
							<td className="muted">Version</td>
							<td>v1.0 (M5–M7 vollständig)</td>
						</tr>
						<tr>
							<td className="muted">Architektur</td>
							<td>Fastify-Core + React-UI, SQLite, SSE-Live-Events</td>
						</tr>
						<tr>
							<td className="muted">Routing</td>
							<td>Mehrachsen-Scoring mit Policies, Failover &amp; Explainability</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	)
}
