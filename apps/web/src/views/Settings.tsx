/**
 * Einstellungen (M7/M9): Routing-Gewichte, **Dokument-Vorlagen** für
 * `plan.md`/`changelog.md`/`init.md`, Daten-Export/-Import, Info.
 */

import {
	AGENT_DOC_FILES,
	type AgentDocKind,
	type ConcurrencySettings,
	DEFAULT_WEIGHTS,
	type DocOwnerKind,
	type DocTemplateSettings,
	defaultDoc,
	docKindsFor,
	normalizeWeights,
	type ScoringWeights,
	type TimeoutSettings,
} from "@diriz/shared"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	IconAlert,
	IconCheck,
	IconCheckCircle,
	IconDoc,
	IconDownload,
	IconInfo,
	IconRefresh,
	IconRoute,
	IconServer,
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
	{
		key: "specFit",
		label: "Eignung",
		hint: "Stärken und Schwächen aus dem `llm.md` des Modells, gemessen am Prompt",
	},
	{
		key: "providerSpread",
		label: "Rechner frei",
		hint: "Bevorzugt eine Maschine, auf der gerade nichts läuft — verteilt die Arbeit über alle Rechner",
	},
	{
		key: "throughput",
		label: "Tempo (gemessen)",
		hint: "Token pro Sekunde aus den letzten Läufen dieses Modells — nicht geschätzt, gemessen",
	},
	{ key: "loadScore", label: "Last", hint: "Aktuelle Auslastung des Providers" },
	{ key: "costScore", label: "Kosten", hint: "Preis pro Token (lokal = 0 $)" },
	{ key: "latencyScore", label: "Latenz", hint: "Antwortgeschwindigkeit" },
	{
		key: "hostLoad",
		label: "Host-Last",
		hint: "RAM-Belegung dieses Rechners — bestraft lokale Modelle bei hoher Last (0 = aus)",
	},
]

/** Ein Benutzer, wie ihn `/api/users` liefert. */
interface UserRow {
	id: string
	username: string
	createdAt: string
	lastLoginAt?: string
}

/** Was das Modell im Agentik-Modus starten darf. */
interface CommandView {
	enabled: boolean
	allowed: string[]
	timeoutMs: number
}

/** Aufbewahrungsfristen in Tagen. */
interface RetentionView {
	logDays: number
	chunkDays: number
	metricsDays: number
}

/** Warmhalte-Einstellungen, wie die Oberfläche sie bearbeitet. */
interface WarmupView {
	enabled: boolean
	intervalMinutes: number
	perProvider: number
}

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

	// Tool-Budget der Agentik — 0 heisst unbegrenzt.
	const [steps, setSteps] = useState<number | null>(null)

	// Zeitgrenzen: Sekunden in der Oberfläche, Millisekunden im Kontrakt.
	const [times, setTimes] = useState<TimeoutSettings | null>(null)
	const [timesBusy, setTimesBusy] = useState(false)
	const [timesSaved, setTimesSaved] = useState(false)

	// Parallelität & GPU-Schutz: harte Grenzen, keine Gewichte.
	const [limits, setLimits] = useState<ConcurrencySettings | null>(null)
	const [limitsBusy, setLimitsBusy] = useState(false)
	const [limitsSaved, setLimitsSaved] = useState(false)

	// Benutzer: Wer darf DiriZ bedienen?
	const [users, setUsers] = useState<UserRow[] | null>(null)
	const [newUser, setNewUser] = useState("")
	const [newPass, setNewPass] = useState("")
	const [pwFor, setPwFor] = useState<string | null>(null)
	const [pwValue, setPwValue] = useState("")
	const [userBusy, setUserBusy] = useState(false)
	const [userMsg, setUserMsg] = useState<string | undefined>()

	// Befehle ausführen: das schärfste Werkzeug — und deshalb hier einstellbar.
	const [cmd, setCmd] = useState<CommandView | null>(null)
	const [cmdBusy, setCmdBusy] = useState(false)
	const [cmdSaved, setCmdSaved] = useState(false)

	// Aufbewahrung: Ohne Frist wächst die Datenbank unbegrenzt.
	const [keep, setKeep] = useState<RetentionView | null>(null)
	const [keepBusy, setKeepBusy] = useState(false)
	const [keepSaved, setKeepSaved] = useState(false)

	// Warmhalten: hält geladene Modelle im Speicher, damit der erste Aufruf
	// nicht Minuten kostet.
	const [warm, setWarm] = useState<WarmupView | null>(null)
	const [warmBusy, setWarmBusy] = useState(false)
	const [warmSaved, setWarmSaved] = useState(false)

	// Dokument-Vorlagen (M9): je Besitzer-Art und Dokumenttyp.
	const [tplOwner, setTplOwner] = useState<DocOwnerKind>("agent")
	const [tplKind, setTplKind] = useState<AgentDocKind>("plan")
	// Ein Modell führt kein `plan.md` — beim Wechsel auf eine Ebene ohne die
	// gewählte Art fällt die Auswahl auf deren erste Art zurück.
	const tplKinds = docKindsFor(tplOwner)
	const activeTplKind = tplKinds.includes(tplKind) ? tplKind : (tplKinds[0] ?? "plan")
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

	useEffect(() => {
		if (settings?.concurrency && limits === null) {
			setLimits(settings.concurrency)
		}
	}, [settings, limits])

	useEffect(() => {
		if (settings?.timeouts && times === null) {
			setTimes(settings.timeouts)
		}
	}, [settings, times])

	useEffect(() => {
		if (settings?.commands && cmd === null) {
			setCmd(settings.commands)
		}
	}, [settings, cmd])

	useEffect(() => {
		if (settings?.retention && keep === null) {
			setKeep(settings.retention)
		}
	}, [settings, keep])

	useEffect(() => {
		if (settings?.warmup && warm === null) {
			setWarm(settings.warmup)
		}
	}, [settings, warm])

	useEffect(() => {
		if (settings?.agent && steps === null) {
			setSteps(settings.agent.maxSteps)
		}
	}, [settings, steps])

	const timesDirty =
		(times !== null && JSON.stringify(times) !== JSON.stringify(settings?.timeouts ?? null)) ||
		(steps !== null && steps !== settings?.agent?.maxSteps)

	const saveTimes = async () => {
		if (!times) return
		setTimesBusy(true)
		try {
			await api.put("/api/settings", { timeouts: times, agent: { maxSteps: steps ?? 0 } })
			await useStore.getState().refreshSettings()
			setTimesSaved(true)
			setTimeout(() => setTimesSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setTimesBusy(false)
		}
	}

	const limitsDirty =
		limits !== null && JSON.stringify(limits) !== JSON.stringify(settings?.concurrency ?? null)

	const saveLimits = async () => {
		if (!limits) return
		setLimitsBusy(true)
		try {
			await api.put("/api/settings", { concurrency: limits })
			await useStore.getState().refreshSettings()
			setLimitsSaved(true)
			setTimeout(() => setLimitsSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setLimitsBusy(false)
		}
	}

	const cmdDirty = cmd !== null && JSON.stringify(cmd) !== JSON.stringify(settings?.commands ?? null)

	const saveCmd = async () => {
		if (!cmd) return
		setCmdBusy(true)
		try {
			await api.put("/api/settings", { commands: cmd })
			await useStore.getState().refreshSettings()
			setCmdSaved(true)
			setTimeout(() => setCmdSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setCmdBusy(false)
		}
	}

	const keepDirty = keep !== null && JSON.stringify(keep) !== JSON.stringify(settings?.retention ?? null)

	const saveKeep = async () => {
		if (!keep) return
		setKeepBusy(true)
		try {
			await api.put("/api/settings", { retention: keep })
			await useStore.getState().refreshSettings()
			setKeepSaved(true)
			setTimeout(() => setKeepSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setKeepBusy(false)
		}
	}

	const loadUsers = useCallback(async () => {
		try {
			setUsers(await api.get<UserRow[]>("/api/users"))
		} catch (e) {
			setUserMsg(e instanceof Error ? e.message : String(e))
		}
	}, [])

	useEffect(() => {
		void loadUsers()
	}, [loadUsers])

	const addUser = async () => {
		setUserBusy(true)
		setUserMsg(undefined)
		try {
			await api.post("/api/users", { username: newUser.trim(), password: newPass })
			setNewUser("")
			setNewPass("")
			await loadUsers()
			setUserMsg("Benutzer angelegt")
		} catch (e) {
			setUserMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setUserBusy(false)
		}
	}

	const changePassword = async (id: string) => {
		setUserBusy(true)
		setUserMsg(undefined)
		try {
			await api.patch(`/api/users/${id}`, { password: pwValue })
			setPwFor(null)
			setPwValue("")
			// Das Ändern beendet alle Sitzungen dieses Benutzers — auch die eigene.
			setUserMsg("Passwort geändert — bestehende Sitzungen wurden beendet")
		} catch (e) {
			setUserMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setUserBusy(false)
		}
	}

	const removeUser = async (u: UserRow) => {
		if (!window.confirm(`Benutzer „${u.username}“ wirklich löschen?`)) {
			return
		}
		setUserBusy(true)
		setUserMsg(undefined)
		try {
			await api.del(`/api/users/${u.id}`)
			await loadUsers()
		} catch (e) {
			setUserMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setUserBusy(false)
		}
	}

	const warmDirty = warm !== null && JSON.stringify(warm) !== JSON.stringify(settings?.warmup ?? null)

	const saveWarm = async () => {
		if (!warm) return
		setWarmBusy(true)
		try {
			await api.put("/api/settings", { warmup: warm })
			await useStore.getState().refreshSettings()
			setWarmSaved(true)
			setTimeout(() => setWarmSaved(false), 2500)
		} catch (e) {
			setImportMsg(e instanceof Error ? e.message : String(e))
		} finally {
			setWarmBusy(false)
		}
	}

	const tplValue = templates?.[tplOwner]?.[activeTplKind] ?? ""
	const tplDirty =
		templates !== null && JSON.stringify(templates) !== JSON.stringify(settings?.docTemplates ?? {})

	/** Leere Vorlage = Schlüssel löschen, damit die eingebaute Vorlage gilt. */
	const setTemplate = (value: string) => {
		setTemplates((prev) => {
			const next: DocTemplateSettings = { ...(prev ?? {}) }
			const group = { ...(next[tplOwner] ?? {}) }
			if (value.trim().length === 0) {
				delete group[activeTplKind]
			} else {
				group[activeTplKind] = value
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
							<IconRefresh size={16} />
							Zeitgrenzen
						</div>
						<div className="card-sub">
							Wie lange DiriZ auf ein Modell wartet. Zu knapp gesetzt, stirbt ein Lauf kurz vor dem Ziel und
							die gesamte Arbeit ist verloren. Agentik-Läufe bekommen automatisch die dreifache Gesamtdauer —
							sie lesen Dateien, denken nach und antworten in mehreren Schritten.
						</div>
					</div>
					{timesDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				{times && (
					<div className="limits">
						{[
							{
								key: "firstChunkMs" as const,
								label: "Warten auf das erste Lebenszeichen",
								hint: "Deckt das Laden des Modells in den Grafikspeicher ab — bei grossen Modellen Minuten.",
							},
							{
								key: "chunkMs" as const,
								label: "Warten zwischen zwei Lebenszeichen",
								hint: "Ein Stream, der mittendrin verstummt, ist ein Fehler und löst ein Failover aus.",
							},
							{
								key: "totalMs" as const,
								label: "Gesamtdauer einer Ausführung",
								hint: "Obergrenze für einen Lauf. Im Agentik-Modus gilt das Dreifache.",
							},
						].map((row) => (
							<label key={row.key} className="limit-row">
								<span className="limit-label">{row.label}</span>
								<input
									type="number"
									min={5}
									step={5}
									value={Math.round(times[row.key] / 1000)}
									onChange={(e) =>
										setTimes({ ...times, [row.key]: Math.max(5, Number(e.target.value) || 5) * 1000 })
									}
								/>
								<span className="field-hint">{row.hint} Angabe in Sekunden.</span>
							</label>
						))}
					</div>
				)}

				{steps !== null && (
					<div className="limits">
						<label className="limit-row">
							<span className="limit-label">Tool-Schritte im Agentik-Modus</span>
							<input
								type="number"
								min={0}
								step={1}
								value={steps}
								onChange={(e) => setSteps(Math.max(0, Number(e.target.value) || 0))}
							/>
							<span className="field-hint">
								<strong>0 = unbegrenzt</strong> (empfohlen). Wie viele Dateien ein Auftrag braucht, weiss
								vorher niemand — ein Budget, das mitten in der Arbeit zuschlägt, kostet den Lauf. Die
								Gesamtdauer oben ist die eigentliche Grenze.
							</span>
						</label>
					</div>
				)}

				<div className="card-actions">
					{timesSaved && <span className="pill ok">gespeichert</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => void saveTimes()}
						disabled={!timesDirty || timesBusy}
					>
						Zeitgrenzen speichern
					</button>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Parallelität & GPU-Schutz
						</div>
						<div className="card-sub">
							Harte Grenzen, keine Gewichte. Sie verhindern, dass ein Rechner mehrere Modelle gleichzeitig in
							den Grafikspeicher lädt — die Arbeit wandert stattdessen auf einen anderen Rechner.
						</div>
					</div>
					{limitsDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				{limits && (
					<div className="limits">
						{[
							{
								key: "maxModelsPerProvider" as const,
								label: "Modelle je Rechner gleichzeitig",
								hint: "1 = strikter GPU-Schutz. Höher nur, wenn der Grafikspeicher wirklich für mehrere Modelle reicht.",
							},
							{
								key: "perProvider" as const,
								label: "Aufträge je Rechner gleichzeitig",
								hint: "Mehrere Aufträge auf demselben Modell sind unkritisch — sie teilen sich den Speicher.",
							},
							{
								key: "global" as const,
								label: "Aufträge insgesamt gleichzeitig",
								hint: "Obergrenze über alle Rechner hinweg.",
							},
						].map((row) => (
							<label key={row.key} className="limit-row">
								<span className="limit-label">{row.label}</span>
								<input
									type="number"
									min={1}
									step={1}
									value={limits[row.key]}
									onChange={(e) =>
										setLimits({ ...limits, [row.key]: Math.max(1, Number(e.target.value) || 1) })
									}
								/>
								<span className="field-hint">{row.hint}</span>
							</label>
						))}
					</div>
				)}

				<div className="card-actions">
					{limitsSaved && <span className="pill ok">gespeichert</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => void saveLimits()}
						disabled={!limitsDirty || limitsBusy}
					>
						Grenzen speichern
					</button>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Modelle warm halten
						</div>
						<div className="card-sub">
							Ein kaltes 30-B-Modell braucht beim ersten Aufruf Minuten, bis es im Grafikspeicher liegt —
							genau die Minuten, die wie ein hängendes Programm aussehen. DiriZ tippt geladene Modelle in
							Abständen an, damit sie geladen bleiben. Rechner, die gerade arbeiten, werden übersprungen; ein
							fremdes Modell wird nie verdrängt.
						</div>
					</div>
					{warmDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				{warm && (
					<div className="limits">
						<label className="limit-row">
							<span className="limit-label">Warmhalten</span>
							<input
								type="checkbox"
								checked={warm.enabled}
								onChange={(e) => setWarm({ ...warm, enabled: e.target.checked })}
							/>
							<span className="field-hint">
								Aus = Modelle kühlen aus und laden beim nächsten Auftrag neu.
							</span>
						</label>
						<label className="limit-row">
							<span className="limit-label">Abstand (Minuten)</span>
							<input
								type="number"
								min={1}
								step={1}
								value={warm.intervalMinutes}
								onChange={(e) =>
									setWarm({ ...warm, intervalMinutes: Math.max(1, Number(e.target.value) || 1) })
								}
							/>
							<span className="field-hint">
								Kürzer als die Auslagerungsfrist des Servers — bei LM Studio sind 4 Minuten sicher.
							</span>
						</label>
						<label className="limit-row">
							<span className="limit-label">Modelle je Rechner</span>
							<input
								type="number"
								min={1}
								step={1}
								value={warm.perProvider}
								onChange={(e) => setWarm({ ...warm, perProvider: Math.max(1, Number(e.target.value) || 1) })}
							/>
							<span className="field-hint">
								Nicht höher als „Modelle je Rechner gleichzeitig“ — sonst wälzt die Grafikkarte pausenlos um.
							</span>
						</label>
					</div>
				)}

				<div className="card-actions">
					{warmSaved && <span className="pill ok">gespeichert</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => void saveWarm()}
						disabled={!warmDirty || warmBusy}
					>
						Warmhalten speichern
					</button>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Befehle ausführen
						</div>
						<div className="card-sub">
							Im Agentik-Modus darf das Modell Programme starten — damit es seine Arbeit <em>prüfen</em> kann,
							statt Prüfskripte zu schreiben, die niemand ausführt. Es gibt keine Shell (Sonderzeichen wie |
							oder &amp;&amp; bleiben Zeichen), gearbeitet wird nur im Task-Ordner, `git` nur lesend. Was hier
							nicht steht, startet nicht.
						</div>
					</div>
					{cmdDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				{cmd && (
					<div className="limits">
						<label className="limit-row">
							<span className="limit-label">Befehle erlauben</span>
							<input
								type="checkbox"
								checked={cmd.enabled}
								onChange={(e) => setCmd({ ...cmd, enabled: e.target.checked })}
							/>
							<span className="field-hint">
								Aus = das Modell kann nichts starten und wird darauf hingewiesen.
							</span>
						</label>
						<label className="limit-row">
							<span className="limit-label">Erlaubte Programme</span>
							<input
								value={cmd.allowed.join(", ")}
								onChange={(e) =>
									setCmd({
										...cmd,
										allowed: e.target.value
											.split(",")
											.map((x) => x.trim())
											.filter((x) => x.length > 0),
									})
								}
							/>
							<span className="field-hint">
								Nur Namen, keine Pfade. Shells (`sh`, `bash`) und alles, was ausserhalb des Ordners wirkt
								(`rm`, `curl`, `sudo`), gehören hier nicht hinein — sie würden die übrigen Grenzen aushebeln.
							</span>
						</label>
						<label className="limit-row">
							<span className="limit-label">Frist je Befehl (Sekunden)</span>
							<input
								type="number"
								min={1}
								step={1}
								value={Math.round(cmd.timeoutMs / 1000)}
								onChange={(e) =>
									setCmd({ ...cmd, timeoutMs: Math.max(1, Number(e.target.value) || 1) * 1000 })
								}
							/>
							<span className="field-hint">Danach wird das Programm hart beendet.</span>
						</label>
					</div>
				)}

				<div className="card-actions">
					{cmdSaved && <span className="pill ok">gespeichert</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => void saveCmd()}
						disabled={!cmdDirty || cmdBusy}
					>
						Regeln speichern
					</button>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Aufbewahrung
						</div>
						<div className="card-sub">
							Wie lange Logzeilen, Antwort-Schnipsel und Kennzahlen bleiben. Ohne Frist wächst die Datenbank
							unbegrenzt und wird mit jeder Woche träger. Tasks, Ausführungen, Dokumente und Bewertungen
							bleiben immer — das ist die Geschichte des Systems.
						</div>
					</div>
					{keepDirty && <span className="pill warn">ungespeichert</span>}
				</div>

				{keep && (
					<div className="limits">
						{[
							{ key: "logDays" as const, label: "Logzeilen (Tage)", hint: "Die kurzlebigste Datenart." },
							{
								key: "chunkDays" as const,
								label: "Antwort-Schnipsel (Tage)",
								hint: "Der Live-Verlauf. Die vollständige Antwort bleibt in jedem Fall erhalten.",
							},
							{
								key: "metricsDays" as const,
								label: "Kennzahlen (Tage)",
								hint: "Stündliche Werte für die Dashboard-Charts.",
							},
						].map((row) => (
							<label key={row.key} className="limit-row">
								<span className="limit-label">{row.label}</span>
								<input
									type="number"
									min={1}
									step={1}
									value={keep[row.key]}
									onChange={(e) => setKeep({ ...keep, [row.key]: Math.max(1, Number(e.target.value) || 1) })}
								/>
								<span className="field-hint">{row.hint}</span>
							</label>
						))}
					</div>
				)}

				<div className="card-actions">
					{keepSaved && <span className="pill ok">gespeichert</span>}
					<button
						type="button"
						className="btn primary"
						onClick={() => void saveKeep()}
						disabled={!keepDirty || keepBusy}
					>
						Fristen speichern
					</button>
				</div>
			</div>

			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconServer size={16} />
							Benutzer
						</div>
						<div className="card-sub">
							Wer sich anmelden darf. Ohne gültige Anmeldung beantwortet der Core keine Anfrage — weder aus
							dieser Oberfläche noch von aussen. Passwörter liegen als scrypt-Hash, im Klartext nirgends.
						</div>
					</div>
				</div>

				{userMsg && <p className="hint">{userMsg}</p>}

				<div className="limits">
					{(users ?? []).map((u) => (
						<div key={u.id} className="limit-row">
							<span className="limit-label">{u.username}</span>
							<span className="field-hint">
								angelegt {new Date(u.createdAt).toLocaleDateString("de-CH")}
								{u.lastLoginAt
									? ` · zuletzt angemeldet ${new Date(u.lastLoginAt).toLocaleString("de-CH")}`
									: " · noch nie angemeldet"}
							</span>
							<span className="row tight">
								<button
									type="button"
									className="btn ghost sm"
									onClick={() => {
										setPwFor(pwFor === u.id ? null : u.id)
										setPwValue("")
									}}
								>
									Passwort ändern
								</button>
								<button
									type="button"
									className="btn ghost sm"
									onClick={() => void removeUser(u)}
									disabled={userBusy || (users?.length ?? 0) <= 1}
									title={
										(users?.length ?? 0) <= 1
											? "Der letzte Benutzer kann nicht gelöscht werden — sonst käme niemand mehr hinein"
											: undefined
									}
								>
									Löschen
								</button>
							</span>
							{pwFor === u.id && (
								<span className="row tight" style={{ gridColumn: "1 / -1" }}>
									<input
										type="password"
										placeholder="neues Passwort (mind. 8 Zeichen)"
										value={pwValue}
										onChange={(e) => setPwValue(e.target.value)}
										autoComplete="new-password"
									/>
									<button
										type="button"
										className="btn primary sm"
										onClick={() => void changePassword(u.id)}
										disabled={userBusy || pwValue.length < 8}
									>
										Speichern
									</button>
								</span>
							)}
						</div>
					))}
				</div>

				<div className="row" style={{ marginTop: "var(--sp-4)", gap: "var(--sp-2)", flexWrap: "wrap" }}>
					<input
						placeholder="Benutzername"
						value={newUser}
						onChange={(e) => setNewUser(e.target.value)}
						autoComplete="off"
					/>
					<input
						type="password"
						placeholder="Passwort (mind. 8 Zeichen)"
						value={newPass}
						onChange={(e) => setNewPass(e.target.value)}
						autoComplete="new-password"
					/>
					<button
						type="button"
						className="btn primary"
						onClick={() => void addUser()}
						disabled={userBusy || newUser.trim().length < 3 || newPass.length < 8}
					>
						Benutzer anlegen
					</button>
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
						{docKindsFor(tplOwner).map((k) => (
							<button
								key={k}
								type="button"
								className={activeTplKind === k ? "active" : ""}
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
					placeholder={defaultDoc(activeTplKind, tplOwner, "{{name}}", "{{datum}}")}
					aria-label={`Vorlage ${AGENT_DOC_FILES[activeTplKind]}`}
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
						onClick={() => setTemplate(defaultDoc(activeTplKind, tplOwner, "{{name}}", "{{datum}}"))}
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
