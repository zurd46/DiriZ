/**
 * Einstellungen (M7/M9): Routing-Gewichte, **Dokument-Vorlagen** für
 * `plan.md`/`changelog.md`/`init.md`, Daten-Export/-Import, Info.
 */

import {
	AGENT_DOC_FILES,
	AGENT_DOC_KINDS,
	type AgentDocKind,
	DEFAULT_WEIGHTS,
	type DocOwnerKind,
	type DocTemplateSettings,
	defaultDoc,
	normalizeWeights,
	type ScoringWeights,
} from "@diriz/shared"
import { useEffect, useRef, useState } from "react"
import {
	IconAlert,
	IconCheck,
	IconCheckCircle,
	IconDoc,
	IconDownload,
	IconInfo,
	IconRefresh,
	IconRoute,
	IconSliders,
	IconTemplate,
	IconUpload,
} from "../components/icons.js"
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

const OWNERS: { id: DocOwnerKind; label: string; hint: string }[] = [
	{ id: "provider", label: "Rechner", hint: "Gilt für jeden neu angebundenen Rechner (Provider)." },
	{ id: "instance", label: "LLM-Modelle", hint: "Gilt für jedes neu entdeckte Modell auf einem Rechner." },
	{ id: "agent", label: "Spezialisten", hint: "Gilt für jeden neu angelegten Spezialisten." },
]

export default function Settings() {
	const settings = useStore((s) => s.settings)
	const lastError = useStore((s) => s.lastError)
	const [draft, setDraft] = useState<ScoringWeights | null>(null)
	const [saved, setSaved] = useState(false)
	const [busy, setBusy] = useState(false)
	const [importMsg, setImportMsg] = useState<string | undefined>()
	const fileRef = useRef<HTMLInputElement>(null)

	// Dokument-Vorlagen (M9): je Besitzer-Art und Dokumenttyp.
	const [tplOwner, setTplOwner] = useState<DocOwnerKind>("agent")
	const [tplKind, setTplKind] = useState<AgentDocKind>("plan")
	const [templates, setTemplates] = useState<DocTemplateSettings | null>(null)
	const [tplBusy, setTplBusy] = useState(false)
	const [tplSaved, setTplSaved] = useState(false)

	useEffect(() => {
		if (settings && draft === null) {
			setDraft(settings.routingWeights)
		}
	}, [settings, draft])

	useEffect(() => {
		if (settings && templates === null) {
			setTemplates(settings.docTemplates ?? {})
		}
	}, [settings, templates])

	const tplValue = templates?.[tplOwner]?.[tplKind] ?? ""
	const tplDirty =
		templates !== null && JSON.stringify(templates) !== JSON.stringify(settings?.docTemplates ?? {})

	/** Leere Vorlage = Schlüssel löschen, damit die eingebaute Vorlage gilt. */
	const setTemplate = (value: string) => {
		setTemplates((prev) => {
			const next: DocTemplateSettings = { ...(prev ?? {}) }
			const group = { ...(next[tplOwner] ?? {}) }
			if (value.trim().length === 0) {
				delete group[tplKind]
			} else {
				group[tplKind] = value
			}
			if (Object.keys(group).length === 0) {
				delete next[tplOwner]
			} else {
				next[tplOwner] = group
			}
			return next
		})
	}

	const saveTemplates = async () => {
		if (!templates) return
		setTplBusy(true)
		try {
			await api.put("/api/settings", { docTemplates: templates })
			await useStore.getState().refreshSettings()
			setTplSaved(true)
			setTimeout(() => setTplSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setTplBusy(false)
		}
	}

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
		<div className="fade-in">
			<div className="page-head">
				<div>
					<h1>Einstellungen</h1>
					<p className="page-sub">
						Routing-Verhalten, Dokument-Vorlagen und Datenhaltung dieser DiriZ-Installation.
					</p>
				</div>
			</div>

			{lastError && (
				<div className="banner error" role="alert">
					<IconAlert size={17} />
					<span className="banner-text">{lastError}</span>
				</div>
			)}

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconSliders size={16} />
							Routing-Gewichte
						</div>
						<div className="card-sub">
							Steuert, wie DiriZ das beste Modell auswählt. Die Gewichte werden automatisch renormiert (Summe
							= 100 %).
						</div>
					</div>
					{dirty && <span className="pill warn">ungespeichert</span>}
				</div>

				<div className="weights">
					{draft &&
						normalized &&
						WEIGHT_META.map((w) => (
							<div key={w.key}>
								<div className="kv">
									<span title={w.hint}>
										{w.label}
										<span className="badge accent">{Math.round((normalized[w.key] ?? 0) * 100)} %</span>
									</span>
									<span className="mono faint">{(draft[w.key] ?? 0).toFixed(2)}</span>
								</div>
								<input
									type="range"
									min={0}
									max={1}
									step={0.01}
									value={draft[w.key]}
									onChange={(e) => setDraft({ ...draft, [w.key]: Number(e.target.value) })}
									style={{ marginTop: 6 }}
									aria-label={w.label}
								/>
								<div className="field-hint" style={{ marginTop: 3 }}>
									{w.hint}
								</div>
							</div>
						))}
				</div>

				<div className="row" style={{ marginTop: 18 }}>
					<button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
						{busy ? "Speichere …" : "Speichern"}
					</button>
					<button type="button" className="btn" onClick={() => setDraft({ ...DEFAULT_WEIGHTS })}>
						<IconRefresh size={15} />
						Defaults wiederherstellen
					</button>
					{saved && (
						<span className="text-ok row tight text-sm">
							<IconCheckCircle size={15} />
							Gespeichert — gilt ab der nächsten Task.
						</span>
					)}
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconTemplate size={16} />
							Dokument-Vorlagen
						</div>
						<div className="card-sub">
							Startinhalt von <code>plan.md</code>, <code>changelog.md</code> und <code>init.md</code>. Jeder
							Spezialist und jede LLM-Instanz bekommt diese drei Dokumente automatisch — hier steht, was beim
							Anlegen darin steht.
						</div>
					</div>
					{tplDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				<p className="hint" style={{ marginTop: 12 }}>
					<IconInfo size={14} />
					<span>
						Platzhalter: <code>{"{{name}}"}</code>, <code>{"{{datum}}"}</code>, <code>{"{{datei}}"}</code> ·
						Leeres Feld = eingebaute Vorlage.
					</span>
				</p>

				<div className="row" style={{ marginTop: 14 }}>
					<div className="seg">
						{OWNERS.map((o) => (
							<button
								key={o.id}
								type="button"
								className={tplOwner === o.id ? "active" : ""}
								title={o.hint}
								onClick={() => setTplOwner(o.id)}
							>
								{o.label}
							</button>
						))}
					</div>
					<div className="seg">
						{AGENT_DOC_KINDS.map((k) => (
							<button
								key={k}
								type="button"
								className={tplKind === k ? "active" : ""}
								onClick={() => setTplKind(k)}
							>
								<IconDoc size={13} />
								{AGENT_DOC_FILES[k]}
								{templates?.[tplOwner]?.[k] ? <IconCheck size={12} /> : null}
							</button>
						))}
					</div>
				</div>

				<textarea
					className="mono"
					style={{ minHeight: 220, marginTop: 12 }}
					value={tplValue}
					onChange={(e) => setTemplate(e.target.value)}
					placeholder={defaultDoc(tplKind, tplOwner, "{{name}}", "{{datum}}")}
					aria-label={`Vorlage ${AGENT_DOC_FILES[tplKind]}`}
				/>

				<div className="row" style={{ marginTop: 12 }}>
					<button
						type="button"
						className="btn primary"
						disabled={!tplDirty || tplBusy}
						onClick={() => void saveTemplates()}
					>
						{tplBusy ? "Speichere …" : "Speichern"}
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => setTemplate(defaultDoc(tplKind, tplOwner, "{{name}}", "{{datum}}"))}
					>
						Eingebaute Vorlage übernehmen
					</button>
					<button type="button" className="btn ghost" disabled={!tplValue} onClick={() => setTemplate("")}>
						<IconRefresh size={15} />
						Zurücksetzen
					</button>
					{tplSaved && (
						<span className="text-ok row tight text-sm">
							<IconCheckCircle size={15} />
							Gespeichert — gilt für neu angelegte Einträge.
						</span>
					)}
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconDownload size={16} />
							Daten
						</div>
						<div className="card-sub">
							Export/Import von Agenten, Swarms, Templates und Settings. Provider &amp; API-Keys werden
							bewusst nicht exportiert.
						</div>
					</div>
				</div>
				<div className="row" style={{ marginTop: 14 }}>
					<button type="button" className="btn" onClick={() => void exportData()}>
						<IconDownload size={15} />
						Export (JSON)
					</button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						hidden
						onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])}
					/>
					<button type="button" className="btn" onClick={() => fileRef.current?.click()}>
						<IconUpload size={15} />
						Import (JSON)
					</button>
				</div>
				{importMsg && (
					<div className="banner info" style={{ marginTop: 12, marginBottom: 0 }}>
						<IconInfo size={16} />
						<span className="banner-text">{importMsg}</span>
					</div>
				)}
			</div>

			<div className="card">
				<div className="card-title">
					<IconRoute size={16} />
					Über DiriZ
				</div>
				<div className="stack" style={{ marginTop: 12, gap: 0 }}>
					<div className="kv">
						<span>Version</span>
						<span>v1.0 (M5–M9)</span>
					</div>
					<div className="kv">
						<span>Architektur</span>
						<span>Fastify-Core + React-UI, SQLite, SSE-Live-Events</span>
					</div>
					<div className="kv">
						<span>Routing</span>
						<span>Mehrachsen-Scoring mit Policies, Failover &amp; Explainability</span>
					</div>
				</div>
			</div>
		</div>
	)
}
