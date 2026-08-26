/**
 * T1-4 Zeitplan: geplante & wiederkehrende Tasks.
 *
 * Drei Planarten:
 *   • einmalig   → konkretes Datum (lokal)
 *   • Intervall  → alle n Minuten
 *   • Cron       → 5 Felder (Minute, Stunde, Tag, Monat, Wochentag)
 *
 * Pro Plan: pausieren/aktivieren, „jetzt starten", löschen. Die letzte
 * Ausführung ist mit der Task verlinkt.
 */
import { useCallback, useEffect, useState } from "react"
import {
	IconClock,
	IconClose,
	IconPlay,
	IconPlus,
	IconRefresh,
	IconStop,
	IconTrash,
} from "../components/icons.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

interface ScheduleView {
	id: string
	title: string
	prompt: string
	agentId: string | null
	privacy: "local-only" | "allow-cloud"
	pinnedProviderId: string | null
	pinnedModelId: string | null
	cron: string | null
	everyMinutes: number | null
	once: boolean
	nextRunAt: string | null
	enabled: boolean
	lastRunTaskId: string | null
	lastRunAt: string | null
	createdAt: string
}

type PlanArt = "once" | "interval" | "cron"

function formatZeit(iso: string | null | undefined): string {
	if (!iso) {
		return "—"
	}
	return new Date(iso).toLocaleString("de-DE", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

/** Beschreibt die Planart in einem Wort — für die Kachel. */
function beschreibung(s: ScheduleView): string {
	if (s.once) {
		return "einmalig"
	}
	if (s.everyMinutes !== null) {
		const m = s.everyMinutes
		return m >= 1440
			? `alle ${Math.round(m / 1440)} Std.`
			: m >= 60
				? `alle ${Math.round(m / 60)} Std.`
				: `alle ${m} Min.`
	}
	if (s.cron) {
		return `Cron ${s.cron}`
	}
	return "ohne Zeit"
}

export default function Schedules() {
	const agents = useStore((s) => s.agents)
	const notify = useStore((s) => s.notify)

	const [schedules, setSchedules] = useState<ScheduleView[]>([])
	const [loaded, setLoaded] = useState(false)
	const [error, setError] = useState<string | undefined>()
	const [busy, setBusy] = useState<string | undefined>() // id des laufenden Buttons
	const [showForm, setShowForm] = useState(false)

	// Formular
	const [title, setTitle] = useState("")
	const [prompt, setPrompt] = useState("")
	const [art, setArt] = useState<PlanArt>("once")
	const [einmaligZeit, setEinmaligZeit] = useState("") // datetime-local
	const [intervall, setIntervall] = useState("60")
	const [cron, setCron] = useState("0 9 * * *")
	const [agentId, setAgentId] = useState("")
	const [privacy, setPrivacy] = useState<"local-only" | "allow-cloud">("local-only")

	const laden = useCallback(() => {
		api
			.get<ScheduleView[]>("/api/schedules")
			.then((s) => {
				setSchedules(s)
				setLoaded(true)
			})
			.catch((e) => setError(e.message))
	}, [])

	useEffect(() => {
		void laden()
	}, [laden])

	const fehler = (e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e)
		setError(msg)
		notify("error", msg)
	}

	const speichern = async () => {
		setBusy("speichern")
		try {
			const body: Record<string, unknown> = { title, prompt, privacy, agentId: agentId || undefined }
			if (art === "once") {
				body.once = true
				body.nextRunAt = new Date(einmaligZeit).toISOString()
			} else if (art === "interval") {
				body.everyMinutes = Number(intervall)
			} else {
				body.cron = cron.trim()
			}
			await api.post("/api/schedules", body)
			notify("success", "Zeitplan angelegt")
			setShowForm(false)
			setTitle("")
			setPrompt("")
			void laden()
		} catch (e) {
			fehler(e)
		} finally {
			setBusy(undefined)
		}
	}

	const umschalten = async (s: ScheduleView) => {
		setBusy(s.id)
		try {
			await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled })
			void laden()
		} catch (e) {
			fehler(e)
		} finally {
			setBusy(undefined)
		}
	}

	const loeschen = async (s: ScheduleView) => {
		if (!window.confirm(`Zeitplan „${s.title}" wirklich löschen?`)) {
			return
		}
		setBusy(s.id)
		try {
			await api.del(`/api/schedules/${s.id}`)
			notify("success", "Zeitplan gelöscht")
			void laden()
		} catch (e) {
			fehler(e)
		} finally {
			setBusy(undefined)
		}
	}

	const jetztStarten = async (s: ScheduleView) => {
		setBusy(s.id)
		try {
			const r = await api.post<{ taskId: string }>(`/api/schedules/${s.id}/run-now`, {})
			notify("success", `„${s.title}" gestartet`)
			goToTask(r.taskId)
			void laden()
		} catch (e) {
			fehler(e)
		} finally {
			setBusy(undefined)
		}
	}

	/** Zur Task springen — die Tasks-Ansicht liest den `?task=`-Parameter. */
	const goToTask = (taskId: string) => {
		window.history.pushState({ route: "tasks" }, "", `/tasks?task=${encodeURIComponent(taskId)}`)
		// Der Router (useRoute) reagiert auf popstate und wechselt die Ansicht.
		window.dispatchEvent(new PopStateEvent("popstate"))
	}

	const aktivesFormular = showForm

	return (
		<div className="stack">
			<div className="card">
				<div className="card-head">
					<div>
						<div className="card-title">
							<IconClock size={16} />
							Zeitplan
						</div>
						<div className="card-sub">
							Geplante und wiederkehrende Tasks — der Core startet sie zur fälligen Uhrzeit.
						</div>
					</div>
					<button
						type="button"
						className="btn-primary"
						onClick={() => setShowForm((v) => !v)}
						aria-expanded={showForm}
					>
						{showForm ? <IconClose size={15} /> : <IconPlus size={15} />}
						{showForm ? "Abbrechen" : "Neuer Zeitplan"}
					</button>
				</div>

				{error && (
					<div className="banner warn" role="alert" style={{ marginTop: 12 }}>
						<span className="banner-text">{error}</span>
					</div>
				)}

				{!loaded ? (
					<p className="muted" style={{ marginTop: 12 }}>
						…
					</p>
				) : schedules.length === 0 ? (
					<p className="muted text-sm" style={{ marginTop: 12 }}>
						Noch keine Zeitpläne. Lege oben einen an — einmalig, im Intervall oder per Cron.
					</p>
				) : (
					<div className="table-wrap" style={{ marginTop: 14 }}>
						<table className="table">
							<thead>
								<tr>
									<th>Plan</th>
									<th>Rhythmus</th>
									<th>Nächster Lauf</th>
									<th>Letzter Lauf</th>
									<th style={{ textAlign: "right" }}>Aktionen</th>
								</tr>
							</thead>
							<tbody>
								{schedules.map((s) => (
									<tr key={s.id} className={s.enabled ? "" : "dimmed"}>
										<td>
											<strong>{s.title}</strong>
											<div className="faint text-sm">{s.prompt.slice(0, 80)}</div>
											{!s.enabled && <span className="badge">pausiert</span>}
										</td>
										<td className="muted">{beschreibung(s)}</td>
										<td className="muted">{formatZeit(s.nextRunAt)}</td>
										<td>
											{s.lastRunTaskId ? (
												<>
													<div className="muted">{formatZeit(s.lastRunAt)}</div>
													<button
														type="button"
														className="link-btn"
														onClick={() => goToTask(s.lastRunTaskId as string)}
													>
														Task ansehen
													</button>
												</>
											) : (
												<span className="faint">noch nie</span>
											)}
										</td>
										<td style={{ textAlign: "right" }}>
											<div className="row tight" style={{ justifyContent: "flex-end" }}>
												<button
													type="button"
													className="icon-btn"
													title={s.enabled ? "Pausieren" : "Aktivieren"}
													disabled={busy === s.id}
													onClick={() => void umschalten(s)}
												>
													{s.enabled ? <IconStop size={15} /> : <IconPlay size={15} />}
												</button>
												<button
													type="button"
													className="icon-btn"
													title="Jetzt starten"
													disabled={busy === s.id}
													onClick={() => void jetztStarten(s)}
												>
													<IconRefresh size={15} />
												</button>
												<button
													type="button"
													className="icon-btn danger"
													title="Löschen"
													disabled={busy === s.id}
													onClick={() => void loeschen(s)}
												>
													<IconTrash size={15} />
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{aktivesFormular && (
				<div className="card">
					<div className="card-head">
						<div className="card-title">
							<IconPlus size={16} />
							Neuer Zeitplan
						</div>
					</div>

					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field grow">
							Titel
							<input
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="z. B. Morgens-Report"
							/>
						</label>
						<label className="field">
							Privatsphäre
							<select
								value={privacy}
								onChange={(e) => setPrivacy(e.target.value as "local-only" | "allow-cloud")}
							>
								<option value="local-only">local-only</option>
								<option value="allow-cloud">allow-cloud</option>
							</select>
						</label>
						<label className="field">
							Spezialist (optional)
							<select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
								<option value="">auto (Routing)</option>
								{agents
									.filter((a) => a.enabled)
									.map((a) => (
										<option key={a.id} value={a.id}>
											{a.name}
										</option>
									))}
							</select>
						</label>
					</div>

					<label className="field" style={{ marginTop: 14 }}>
						Prompt
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder="Was soll die Task bei jedem Lauf tun?"
						/>
					</label>

					<div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
						<label className="field">
							Rhythmus
							<select value={art} onChange={(e) => setArt(e.target.value as PlanArt)}>
								<option value="once">einmalig</option>
								<option value="interval">Intervall</option>
								<option value="cron">Cron</option>
							</select>
						</label>
						{art === "once" && (
							<label className="field">
								Zeitpunkt
								<input
									type="datetime-local"
									value={einmaligZeit}
									onChange={(e) => setEinmaligZeit(e.target.value)}
								/>
							</label>
						)}
						{art === "interval" && (
							<label className="field">
								Alle Minuten
								<input
									type="number"
									min={1}
									value={intervall}
									onChange={(e) => setIntervall(e.target.value)}
								/>
							</label>
						)}
						{art === "cron" && (
							<label className="field grow">
								Cron (Minute, Stunde, Tag, Monat, Wochentag)
								<input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
							</label>
						)}
					</div>

					<div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
						<button
							type="button"
							className="btn-primary"
							disabled={busy === "speichern" || !title.trim() || !prompt.trim()}
							onClick={() => void speichern()}
						>
							{busy === "speichern" ? "Wird angelegt …" : "Zeitplan anlegen"}
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
