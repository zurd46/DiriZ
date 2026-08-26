/**
 * Chat — der einfache Einstieg: Aufgabe beschreiben, DiriZ sucht den passenden
 * Spezialisten und arbeitet.
 *
 * Zwei Entwurfsentscheidungen tragen die Ansicht:
 *
 * 1. **Keine zweite Ausführungsschiene.** Jede Nachricht ist eine ganz normale
 *    Task (`assignmentMode: "auto"`). Zuordnung, Routing, Failover und Dateien
 *    macht die Engine — die Ansicht zeigt nur, was passiert.
 * 2. **Der Verlauf ist die Datenbank.** Gespräche werden über `metadata.chatId`
 *    zusammengefasst und aus `/api/chats` geladen. Nichts liegt nur im Browser,
 *    also überlebt der Verlauf Neuladen, Browserwechsel und Neustart.
 *
 * Alles Laufende kommt live über den SSE-Stream: welcher Rechner rechnet, ob
 * das Modell noch geladen wird, was es gerade schreibt, welche Dateien es anfasst.
 */

import {
	estimateTokens,
	type FileDiff,
	findBlueprint,
	type GitStatus,
	type InstanceModel,
	type Repo,
	type SwarmStep,
	stagesOf,
} from "@diriz/shared"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import DiffView from "../components/DiffView.js"
import {
	IconAgents,
	IconAlert,
	IconChat,
	IconChevronRight,
	IconDoc,
	IconEdit,
	IconGitBranch,
	IconPlay,
	IconPlus,
	IconRefresh,
	IconServer,
	IconStop,
	IconTool,
	IconTrash,
	IconUpload,
	IconWorkspace,
} from "../components/icons.js"
import Markdown from "../components/Markdown.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

/** Wo die Arbeit stattfindet — bestimmt Werkzeuge und Arbeitsverzeichnis. */
type Target = "answer" | "workspace" | "repo"

const TARGETS: { id: Target; label: string; hint: string }[] = [
	{ id: "answer", label: "Nur antworten", hint: "Text ohne Dateizugriff — Fragen, Konzepte, Reviews" },
	{ id: "workspace", label: "Projekt anlegen", hint: "Darf Dateien im Workspace schreiben" },
	{
		id: "repo",
		label: "Repository ändern",
		hint: "Arbeitet im Git-Worktree eines verbundenen Repos — dafür muss es unter „GitHub“ angebunden sein (Token allein genügt nicht)",
	},
]

/** Eine Nachricht samt Antwort, so wie der Core sie zurückgibt. */
interface Turn {
	taskId: string
	prompt: string
	status: string
	createdAt: string
	agentMode: boolean
	/** Gesetzt, wenn diese Nachricht die Übergabe eines Kettenschritts ist. */
	chain: { step: number; total: number } | null
	/** A/B-Vergleich (T1-1): gemeinsame Kennung aller Spalten eines Duells. */
	compareId?: string | null
	/** Gepinntes Repository — dann gibt es Diff, Commit und Push direkt hier. */
	repoId: string | null
	agentName: string | null
	agentReason: string | null
	modelName: string | null
	providerLabel: string | null
	answer: string
	error: string | null
	files: { relPath: string; size: number }[]
	/** Chat-Nachricht — Bilder (T1-2) als Thumbnails über dem Text. */
	attachments?: { filename: string; mime: string; sizeBytes: number; dataUri: string }[]
	/** Dateioperationen des Modells — aus der Datenbank, überlebt das Neuladen. */
	toolCalls: { id: string; name: string; argsSummary: string; ok: boolean }[]
}

interface ChatSummary {
	chatId: string
	title: string
	createdAt: string
	updatedAt: string
	turns: Turn[]
}

/**
 * Verlangt der Auftrag Dateizugriff? „Nur antworten“ liefert dann eine
 * allgemeine Abhandlung statt einer Prüfung am echten Code — der häufigste
 * Fehlgriff, weil die Absicht im Text steht und nicht in der Zielwahl.
 */
const NEEDS_FILES =
	/\b(im|ins|am|das|dem|unser[nm]?|meine[nmr]?)\s+(projekt|repo|repository|code|codebase|quellcode)\b|\b(datei|dateien|quelltext|implementier|umsetzen|einbauen|beheb|fixe?n?)\b/i

/**
 * Zerlegt die Übergabe eines Kettenschritts in ihre drei Abschnitte.
 *
 * Der Core baut sie als Markdown mit festen Überschriften (`## Ursprünglicher
 * Auftrag`, `## Vorarbeit aus Schritt N`, `## Deine Aufgabe`). Hier wird sie
 * wieder auseinandergenommen, damit die Vorarbeit — oft tausende Zeichen des
 * vorigen Spezialisten — zugeklappt werden kann, statt den Verlauf zu fluten.
 *
 * `null`, wenn das Format nicht passt: Dann wird die Nachricht ganz normal
 * gerendert, statt sie zu verstümmeln.
 */
function splitHandoff(
	prompt: string,
): { goal: string; prior: string; priorTitle: string; task: string } | null {
	const m = prompt.match(
		/^##\s*Ursprünglicher Auftrag\s*\n([\s\S]*?)\n##\s*(Vorarbeit[^\n]*)\n([\s\S]*?)\n##\s*Deine Aufgabe\s*\n([\s\S]*)$/,
	)
	if (!m) {
		return null
	}
	return {
		goal: (m[1] ?? "").trim(),
		priorTitle: (m[2] ?? "").trim(),
		prior: (m[3] ?? "").trim(),
		task: (m[4] ?? "").trim(),
	}
}

/** Titel aus der ersten Zeile — er benennt später auch den Git-Branch. */
function titleFrom(prompt: string): string {
	const first = prompt.trim().split(/\r?\n/)[0] ?? ""
	return first.length > 70 ? `${first.slice(0, 67)}…` : first || "Chat"
}

/** Gekürzter Verlauf als Vorspann — sonst beantwortet jede Task nur sich selbst. */
function withHistory(prompt: string, history: { prompt: string; answer: string }[]): string {
	if (history.length === 0) {
		return prompt
	}
	const lines = ["Bisheriger Verlauf (Kontext, nicht erneut beantworten):", ""]
	for (const h of history.slice(-2)) {
		lines.push(`Frage: ${h.prompt.slice(0, 800)}`)
		lines.push(`Antwort: ${h.answer.slice(0, 1200)}`)
		lines.push("")
	}
	lines.push("Neue Aufgabe:", prompt)
	return lines.join("\n")
}

/**
 * Die Änderungen des Spezialisten als Diff — Datei für Datei, mit alter und
 * neuer Zeilennummer. Steht direkt bei der Antwort, weil das die eigentliche
 * Arbeit ist; GitHub kommt danach.
 */
function ChatDiff({ taskId, refreshKey }: { taskId: string; refreshKey: number }) {
	const [files, setFiles] = useState<FileDiff[] | null>(null)

	// `refreshKey` ist das Signal, nicht der Wert: Die Eltern-Ansicht erhöht ihn,
	// wenn der Lauf Dateien geschrieben hat — sonst bliebe der Diff alt.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bewusstes Auslöser-Signal
	useEffect(() => {
		let alive = true
		api
			.get<{ files: FileDiff[] }>(`/api/tasks/${taskId}/git/diff`)
			.then((d) => alive && setFiles(d.files))
			.catch(() => alive && setFiles(null))
		return () => {
			alive = false
		}
	}, [taskId, refreshKey])

	if (!files || files.length === 0) {
		return null
	}
	return (
		<div className="chat-diff">
			<div className="chat-block-head">
				<IconDoc size={14} />
				Geänderte Dateien
				<span className="badge soft">{files.length}</span>
			</div>
			<DiffView files={files} defaultOpen={2} />
		</div>
	)
}

/**
 * GitHub-Abschluss einer Nachricht: Wohin die Arbeit gegangen ist und was noch
 * fehlt. Bewusst am Ende — erst das Ergebnis, dann die Veröffentlichung.
 *
 * Committet und gepusht wird automatisch (Einstellungen → Git); hier steht der
 * Zustand und der Weg zum Pull-Request.
 */
function ChatGitHub({ taskId, refreshKey }: { taskId: string; refreshKey: number }) {
	const notify = useStore((s) => s.notify)
	const setLastError = useStore((s) => s.setLastError)
	const [status, setStatus] = useState<GitStatus | null>(null)
	const [busy, setBusy] = useState<string | undefined>()

	const load = useCallback(() => {
		api
			.get<GitStatus>(`/api/tasks/${taskId}/git`)
			.then(setStatus)
			.catch(() => setStatus(null))
	}, [taskId])

	// `refreshKey` löst das Neuladen aus (Commit, Push, neuer Lauf).
	// biome-ignore lint/correctness/useExhaustiveDependencies: bewusstes Auslöser-Signal
	useEffect(() => {
		load()
	}, [load, refreshKey])

	const run = async (label: string, fn: () => Promise<void>) => {
		setBusy(label)
		try {
			await fn()
			load()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(undefined)
		}
	}

	if (!status) {
		return null
	}
	return (
		<div className="chat-github">
			<div className="chat-block-head">
				<IconGitBranch size={14} />
				{status.repo.fullName}
				<span className="badge mono">{status.workBranch}</span>
				{status.dirty ? (
					<span className="pill warn">nicht committet</span>
				) : status.pushed ? (
					<span className="pill ok">auf GitHub</span>
				) : (
					<span className="pill queued">nur lokal</span>
				)}
			</div>
			<div className="chat-github-meta">
				<span>
					+{status.additions} / −{status.deletions} Zeilen · {status.files.length} Datei(en) ·{" "}
					{status.commits.length} Commit(s) vor <span className="mono">{status.baseBranch}</span>
				</span>
			</div>
			<div className="chat-github-actions">
				{status.dirty && (
					<button
						type="button"
						className="btn sm"
						disabled={busy !== undefined}
						onClick={() =>
							run("commit", async () => {
								const r = await api.post<{ shortSha: string; filesChanged: number }>(
									`/api/tasks/${taskId}/git/commit`,
									{},
								)
								notify("success", `Commit ${r.shortSha} — ${r.filesChanged} Datei(en)`)
							})
						}
					>
						Committen
					</button>
				)}
				{!status.pushed && (
					<button
						type="button"
						className="btn sm"
						disabled={busy !== undefined}
						onClick={() =>
							run("push", async () => {
								const r = await api.post<{ branch: string }>(`/api/tasks/${taskId}/git/push`, {})
								notify("success", `Gepusht nach ${r.branch}`)
							})
						}
					>
						<IconUpload size={13} />
						Pushen
					</button>
				)}
				{status.prUrl ? (
					<a className="btn sm" href={status.prUrl} target="_blank" rel="noreferrer">
						Pull-Request ansehen
					</a>
				) : (
					<button
						type="button"
						className="btn sm primary"
						disabled={busy !== undefined || !status.pushed}
						title={status.pushed ? undefined : "Erst pushen"}
						onClick={() =>
							run("pr", async () => {
								const r = await api.post<{ url: string; existed: boolean }>(
									`/api/tasks/${taskId}/git/pull-request`,
									{},
								)
								notify("success", r.existed ? "Pull-Request existierte bereits" : "Pull-Request geöffnet")
								window.open(r.url, "_blank", "noreferrer")
							})
						}
					>
						Pull-Request öffnen
					</button>
				)}
			</div>
		</div>
	)
}

/** Ein Werkzeug-Aufruf, mehrfach gleiche zusammengefasst. */
interface ToolBadge {
	id: string
	name: string
	target: string
	ok: boolean
	count: number
}

/**
 * Fasst gleiche Aufrufe zusammen. Modelle lesen dieselbe Datei gern mehrfach —
 * sechs identische Zeilen sagen nichts, was „read_file api/render.js ×6“ nicht
 * kürzer und ehrlicher sagt.
 */
function toolBadges(ops: { id: string; name: string; argsSummary: string; ok: boolean }[]): ToolBadge[] {
	const out: ToolBadge[] = []
	for (const op of ops) {
		const target = op.argsSummary === "(keine Argumente)" ? "" : op.argsSummary
		const last = out.find((b) => b.name === op.name && b.target === target && b.ok === op.ok)
		if (last) {
			last.count++
		} else {
			out.push({ id: op.id, name: op.name, target, ok: op.ok, count: 1 })
		}
	}
	return out
}

/**
 * Lange Pfade kürzen: `src/composables/useSeo.js` bleibt, aber
 * `a/b/c/d/e/useSeo.js` wird zu `…/e/useSeo.js`. Vorn steht selten die
 * Information, hinten immer.
 */
function shortPath(value: string): string {
	const parts = value.split("/")
	return parts.length <= 2 ? value : `…/${parts.slice(-2).join("/")}`
}

/** Kurzname des Werkzeugs für das Badge — „read_file“ liest sich schlecht. */
const TOOL_LABEL: Record<string, string> = {
	list_files: "Dateien auflisten",
	read_file: "gelesen",
	search_files: "gesucht",
	file_info: "nachgesehen",
	write_file: "geschrieben",
	edit_file: "geändert",
	append_file: "angehängt",
	delete_file: "gelöscht",
	move_file: "verschoben",
	copy_file: "kopiert",
	make_dir: "Ordner angelegt",
}

/**
 * Werkzeuge, die etwas **verändern** — sie bekommen das Stift-Symbol und die
 * grüne Färbung. Ein Blick auf die Leiste soll reichen, um zu sehen, ob ein
 * Lauf nur gelesen oder auch gearbeitet hat.
 */
const MUTATING_BADGES = new Set([
	"write_file",
	"edit_file",
	"append_file",
	"delete_file",
	"move_file",
	"copy_file",
	"make_dir",
])

/** Statusworte, wie ein Mensch sie erwartet — nicht die Datenbankwerte. */
const STATUS_LABEL: Record<string, string> = {
	draft: "Entwurf",
	routing: "wird zugeordnet",
	queued: "wartet",
	running: "läuft",
	done: "fertig",
	failed: "fehlgeschlagen",
	cancelled: "abgebrochen",
}

const STATUS_PILL: Record<string, string> = {
	running: "running",
	done: "ok",
	failed: "err",
	cancelled: "warn",
	queued: "queued",
	routing: "routing",
}

/**
 * Werkzeug-Leiste einer Antwort. Ab neun Einträgen bleibt sie eingeklappt —
 * zwanzig Badges sagen nichts, was „20 Operationen“ plus die letzten acht
 * nicht kürzer sagen.
 */
/*
 * Vier Badges reichen für den Überblick — der Rest steckt hinter „+N“. Vorher
 * standen acht in der Zeile, was bei einem Agentik-Lauf zwei bis drei Zeilen
 * über der Antwort belegte, bevor sie überhaupt begann.
 */
const TOOL_PREVIEW = 4

function ToolStrip({ badges, total }: { badges: ToolBadge[]; total: number }) {
	const [alle, setAlle] = useState(false)
	const sichtbar = alle ? badges : badges.slice(0, TOOL_PREVIEW)
	const rest = badges.length - sichtbar.length
	const fehler = badges.filter((b) => !b.ok).length

	return (
		<div className="chat-tools">
			<span className="chat-tools-label" title={`${total} Werkzeug-Aufrufe`}>
				<IconTool size={11} />
				{total}
			</span>
			{sichtbar.map((b) => (
				<span key={b.id} className={`tool-badge ${b.ok ? "" : "err"} ${b.name}`} title={b.target || b.name}>
					{MUTATING_BADGES.has(b.name) ? <IconEdit size={11} /> : <IconDoc size={11} />}
					<span className="tool-verb">{TOOL_LABEL[b.name] ?? b.name}</span>
					{b.target && <span className="tool-target">{shortPath(b.target)}</span>}
					{b.count > 1 && <span className="tool-count">×{b.count}</span>}
				</span>
			))}
			{rest > 0 && (
				<button type="button" className="tool-more" onClick={() => setAlle(true)}>
					+{rest}
				</button>
			)}
			{alle && badges.length > TOOL_PREVIEW && (
				<button type="button" className="tool-more" onClick={() => setAlle(false)}>
					weniger
				</button>
			)}
			{/* Fehlgeschlagene Aufrufe stecken sonst irgendwo hinter „+N“. */}
			{!alle && rest > 0 && fehler > 0 && (
				<span className="tool-badge err" title="fehlgeschlagene Aufrufe">
					{fehler} Fehler
				</span>
			)}
		</div>
	)
}

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`

/** Längere Zeiträume als `m:ss` — „412 s“ liest niemand als sieben Minuten. */
function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000))
	if (total < 60) {
		return `${total} s`
	}
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} min`
}

/**
 * A/B-Vergleich (T1-1): derselbe Auftrag auf 2–4 Modellen nebeneinander.
 *
 * Pro Spalte: Modell, Rechner, Status, Dauer, Tempo (Token/s) und die Antwort
 * live. Die Metriken kommen aus dem SSE-Stream (`live`); nach dem Neuladen
 * bleiben die persistierten Antworten im Verlauf — die Metriken dann nicht,
 * das ist akzeptabel, weil die Spalten sich per `compareId` wiederfinden.
 *
 * Diff: Wort-Felder über einen gemeinsamen Längsten-Gemeinsamen-Untersatz —
 * klein genug für eine Antwort, ohne ein zweites Diff-Modul zu brauchen.
 */
function diffWords(a: string, b: string): { text: string; kind: "same" | "add" | "del" }[] {
	const wa = a.split(/\s+/).filter(Boolean)
	const wb = b.split(/\s+/).filter(Boolean)
	const n = wa.length
	const m = wb.length
	// DP-Tabelle für die LCS-Länge — für Antwortgrößen (Worte) kein Problem.
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = wa[i] === wb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
		}
	}
	const out: { text: string; kind: "same" | "add" | "del" }[] = []
	let i = 0
	let j = 0
	while (i < n && j < m) {
		if (wa[i] === wb[j]) {
			out.push({ text: wa[i], kind: "same" })
			i++
			j++
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ text: wa[i], kind: "del" })
			i++
		} else {
			out.push({ text: wb[j], kind: "add" })
			j++
		}
	}
	while (i < n) {
		out.push({ text: wa[i], kind: "del" })
		i++
	}
	while (j < m) {
		out.push({ text: wb[j], kind: "add" })
		j++
	}
	return out
}

function ComparePanel({
	turns,
	runOf,
	workerOf,
	onCancel,
}: {
	turns: Turn[]
	runOf: (taskId: string) =>
		| {
				status?: string
				startedAt?: number
				firstActivityAt?: number
				text?: string
				usage?: { tokensIn?: number; tokensOut?: number; tps?: number; costUsd?: number }
		  }
		| undefined
	workerOf: (t: Turn) => { model?: string; host?: string }
	onCancel: (taskId: string) => void
}) {
	const [showDiff, setShowDiff] = useState(false)
	const [baseIdx, setBaseIdx] = useState(0)
	const answers = turns.map((t) => runOf(t.taskId)?.text ?? t.answer ?? "")
	const finished = turns.every((t) => {
		const st = runOf(t.taskId)?.status ?? t.status
		return st === "done" || st === "failed" || st === "cancelled"
	})
	const base = answers[baseIdx] ?? ""
	const cols = turns.map((t) => {
		const run = runOf(t.taskId)
		const started = run?.startedAt ?? new Date(t.createdAt).getTime()
		const now = Date.now()
		const durMs = run?.status === "done" && run.firstActivityAt !== undefined ? now - started : now - started
		const outTok = run?.usage?.tokensOut
		const tps = outTok !== undefined && durMs > 0 ? (outTok / durMs) * 1000 : run?.usage?.tps
		const cost = run?.usage?.costUsd
		const tokIn = run?.usage?.tokensIn
		return {
			turn: t,
			worker: workerOf(t),
			status: run?.status ?? t.status,
			running: (run?.status ?? t.status) === "running",
			answer: answers[turns.indexOf(t)] ?? "",
			seconds: Math.round(durMs / 1000),
			tps,
			cost,
			tokIn,
		}
	})
	return (
		<div className="compare-panel">
			<div className="compare-head">
				<span className="chat-tools-label" role="status" aria-label="A/B-Vergleich">
					Vergleich · {turns.length} Modelle ·{" "}
					{finished ? "fertig" : `${cols.filter((c) => c.running).length} läuft`}
				</span>
				{finished && turns.length > 1 && (
					<button type="button" className="btn sm" onClick={() => setShowDiff((v) => !v)}>
						{showDiff ? "Diff ausblenden" : "Ergebnisse vergleichen (Diff)"}
					</button>
				)}
			</div>
			{showDiff && finished && turns.length > 1 && (
				<div className="compare-diff">
					<div className="compare-diff-bar">
						<span className="faint">Referenz:</span>
						<select
							value={baseIdx}
							onChange={(e) => setBaseIdx(Number(e.target.value))}
							aria-label="Referenz-Spalte"
						>
							{cols.map((c, i) => (
								<option key={c.turn.taskId} value={i}>
									{c.worker.model ?? `Spalte ${i + 1}`}
								</option>
							))}
						</select>
						<span className="faint">
							<span className="diff-add"> grün = nur anders </span>
							<span className="diff-del"> rot = fehlt </span>
						</span>
					</div>
					{cols.slice(1).map((c, k) => {
						const idx = k + 1
						const parts = base ? diffWords(base, c.answer) : []
						const added = parts.filter((p) => p.kind === "add").length
						const removed = parts.filter((p) => p.kind === "del").length
						return (
							<details key={c.turn.taskId} className="compare-diff-row" open={k === 0}>
								<summary>
									<span className="mono">{c.worker.model ?? `Spalte ${idx + 1}`}</span>
									<span className="faint">
										+{added} · −{removed} Wörter
									</span>
								</summary>
								<div className="compare-diff-body mono">
									{(() => {
										const seen = new Map<string, number>()
										return parts.map((p) => {
											const base = `${p.kind}-${p.text}`
											const n = (seen.get(base) ?? 0) + 1
											seen.set(base, n)
											return (
												<span key={`${base}-${n}`} className={`diff-${p.kind}`}>
													{p.text}{" "}
												</span>
											)
										})
									})()}
								</div>
							</details>
						)
					})}
				</div>
			)}
			<div className="compare-cols">
				{cols.map((c) => (
					<div
						key={c.turn.taskId}
						className={`compare-col ${c.running ? "live" : ""}`}
						data-status={c.status}
					>
						<div className="compare-col-head">
							<span className="mono compare-model">{c.worker.model ?? "…"}</span>
							<span className={`pill ${c.status === "done" ? "ok" : c.status === "failed" ? "err" : "info"}`}>
								{c.status}
							</span>
							{c.running && (
								<button
									type="button"
									className="btn ghost sm icon-only"
									title="Diese Spalte abbrechen"
									aria-label="Abbrechen"
									onClick={() => onCancel(c.turn.taskId)}
								>
									<IconStop size={12} />
								</button>
							)}
						</div>
						{c.worker.host && (
							<div className="compare-col-host">
								<IconServer size={10} />
								<span className="mono">{c.worker.host}</span>
							</div>
						)}
						<div className="compare-metrics">
							<span title="Dauer seit Start">{c.seconds.toLocaleString("de-CH")} s</span>
							{c.tps !== undefined && <span title="Token pro Sekunde">{c.tps.toFixed(0)} Tok/s</span>}
							{c.tokIn !== undefined && <span title="Input-Token">{c.tokIn.toLocaleString("de-CH")} In</span>}
							{c.cost !== undefined && c.cost > 0 && (
								<span title="Kosten dieser Antwort">
									{c.cost < 0.01 ? `< $0.01` : `$${c.cost.toFixed(2)}`}
								</span>
							)}
						</div>
						<div className="compare-answer">
							{c.answer ? <Markdown source={c.answer} /> : c.running ? "…" : (c.turn.error ?? "")}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

export default function Chat() {
	const connected = useStore((s) => s.connected)
	const live = useStore((s) => s.live)
	const providers = useStore((s) => s.providers)
	const agents = useStore((s) => s.agents)
	const setLastError = useStore((s) => s.setLastError)

	const [chats, setChats] = useState<ChatSummary[]>([])
	const [chatId, setChatId] = useState<string>(() => crypto.randomUUID())
	/** Optimistische Nachrichten, die der Server noch nicht kennt. */
	const [pending, setPending] = useState<Turn[]>([])
	const [input, setInput] = useState("")
	const [target, setTarget] = useState<Target>("answer")
	const [repos, setRepos] = useState<Repo[]>([])
	const [repoId, setRepoId] = useState("")
	const [instances, setInstances] = useState<InstanceModel[]>([])
	const [keepContext, setKeepContext] = useState(true)
	/**
	 * Swarm-Modus: mehrere Spezialisten nacheinander statt nur einer.
	 *
	 * Derselbe Begriff wie beim gespeicherten Swarm — es ist dieselbe Sache,
	 * nur pro Prompt zusammengestellt statt vorher festgelegt. Standard, weil
	 * die meisten Aufträge mehr als eine Rolle brauchen; abschaltbar für kurze
	 * Rückfragen, bei denen eine Kette nur Zeit kostet.
	 */
	const [swarmMode, setSwarmMode] = useState(true)
	/**
	 * A/B-Vergleich (T1-1): derselbe Auftrag parallel auf 2–4 gewählten
	 * Modellen — die Spalten erscheinen nebeneinander mit Tempo, Kosten
	 * und Ergebnis-Diff. Stellt Swarm & Schnellmodus still, denn hier
	 * entscheidet nicht das Routing, sondern die Auswahl.
	 */
	const [compareMode, setCompareMode] = useState(false)
	const [compareIds, setCompareIds] = useState<string[]>([])
	/**
	 * Schnellmodus: ein Spezialist, das nachweislich schnellste Modell. Für die
	 * kleine Korrektur, bei der eine gründliche Kette mehr Zeit kostet als die
	 * Aufgabe wert ist.
	 */
	const [fastMode, setFastMode] = useState(false)
	/**
	 * T1-2 Vision-Anhänge: Bilder, die mit der nächsten Nachricht gehen.
	 * Max. 5, je 8 MB — der Core lehnt Größeres ab, die UI warnt vorher.
	 */
	const [bilder, setBilder] = useState<
		{ filename: string; mime: string; sizeBytes: number; dataUri: string }[]
	>([])
	const bildInputRef = useRef<HTMLInputElement | null>(null)
	/** Bild in Base64 lesen, mit den Server-Limiten geprüft (8 MB, max. 5). */
	const addBild = useCallback(
		(file: File) => {
			if (!file.type.startsWith("image/")) {
				setLastError("Nur Bilder werden unterstützt")
				return
			}
			if (file.size > 8_000_000) {
				setLastError("Bild zu groß — maximal 8 MB")
				return
			}
			if (bilder.length >= 5) {
				setLastError("Maximal 5 Bilder pro Nachricht")
				return
			}
			const reader = new FileReader()
			reader.onload = () => {
				setBilder((b) =>
					b.length >= 5
						? b
						: [
								...b,
								{
									filename: file.name,
									mime: file.type,
									sizeBytes: file.size,
									dataUri: String(reader.result),
								},
							],
				)
			}
			reader.readAsDataURL(file)
		},
		[bilder.length, setLastError],
	)
	/**
	 * Dürfen Cloud-Modelle mitspielen?
	 *
	 * Vorher stand `privacy: "local-only"` fest im Code — jede Aufgabe schloss
	 * Cloud-Anbieter aus, auch wenn ein OpenRouter-Zugang mit 417 Modellen
	 * eingerichtet war. Die Entscheidung gehört dem Menschen, nicht dem
	 * Quelltext; die Vorgabe bleibt aber „nur lokal", denn das Gegenteil
	 * schickt Code aus dem Haus.
	 */
	const [cloudErlaubt, setCloudErlaubt] = useState(() => localStorage.getItem("diriz.cloudErlaubt") === "1")
	const [plan, setPlan] = useState<SwarmStep[]>([])
	/**
	 * Verlauf standardmässig zugeklappt — die Unterhaltung bekommt die Breite.
	 * Die Wahl bleibt erhalten (localStorage), damit man sie nicht bei jedem
	 * Aufruf neu treffen muss; ein blockierter Speicher ist kein Fehlerfall.
	 */
	const [historyOpen, setHistoryOpen] = useState(() => {
		try {
			return window.localStorage.getItem("diriz_chat_history") === "1"
		} catch {
			return false
		}
	})
	const [busy, setBusy] = useState(false)
	/** Sekundentakt — nur damit Wartezeiten mitlaufen. */
	const [tick, setTick] = useState(0)
	const endRef = useRef<HTMLDivElement>(null)
	const logRef = useRef<HTMLDivElement>(null)

	const loadChats = useCallback(async () => {
		try {
			setChats(await api.get<ChatSummary[]>("/api/chats"))
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}, [setLastError])

	useEffect(() => {
		void loadChats()
		api
			.get<Repo[]>("/api/repos")
			.then(setRepos)
			.catch(() => setRepos([]))
		api
			.get<InstanceModel[]>("/api/instances")
			.then(setInstances)
			.catch(() => setInstances([]))
	}, [loadChats])

	const current = chats.find((c) => c.chatId === chatId)
	const serverTurns = useMemo(() => current?.turns ?? [], [current])
	const turns = useMemo(() => {
		const known = new Set(serverTurns.map((t) => t.taskId))
		return [...serverTurns, ...pending.filter((t) => !known.has(t.taskId))]
	}, [serverTurns, pending])

	/**
	 * A/B-Vergleich: jede Spalte eines Duells zeigt dasselbe Panel — aber nur
	 * die erste Spalte rendert es, die übrigen verschwinden. `compareGroupOf`
	 * mappt Task-ID auf die Spalten-Gruppe; ohne `compareId` bleibt die
	 * normale Einzel-Renderung.
	 */
	const compareGroupOf = useMemo(() => {
		const map = new Map<string, Turn[]>()
		for (const t of turns) {
			if (!t.compareId) {
				continue
			}
			const existing = map.get(t.compareId)
			if (existing) {
				existing.push(t)
			} else {
				map.set(t.compareId, [t])
			}
		}
		const out = new Map<string, Turn[]>()
		for (const group of map.values()) {
			for (const member of group) {
				out.set(member.taskId, group)
			}
		}
		return out
	}, [turns])

	const running = turns.some((t) => t.status === "running" || t.status === "queued" || t.status === "routing")

	// Uhr nur laufen lassen, solange wirklich etwas läuft.
	useEffect(() => {
		if (!running) {
			return
		}
		const id = setInterval(() => setTick((n) => n + 1), 1000)
		return () => clearInterval(id)
	}, [running])

	// Während eines Laufs regelmässig nachladen. Der SSE-Stream versorgt nur
	// die Sitzung, in der der Lauf gestartet wurde — wer die Seite neu lädt
	// oder in einem zweiten Tab zusieht, bekommt sonst nichts mit.
	useEffect(() => {
		if (!running) {
			return
		}
		const id = setInterval(() => void loadChats(), 5000)
		return () => clearInterval(id)
	}, [running, loadChats])

	// Endet ein Lauf, holt sich die Ansicht die persistierte Antwort — genau
	// einmal je Task. Ohne die Merkliste löste jeder Token ein Nachladen aus.
	const reloaded = useRef(new Set<string>())
	useEffect(() => {
		for (const run of Object.values(live)) {
			const done = run.status === "done" || run.status === "failed"
			if (done && run.taskId && !reloaded.current.has(run.taskId)) {
				reloaded.current.add(run.taskId)
				void loadChats()
			}
		}
	}, [live, loadChats])

	/**
	 * Immer das Ende zeigen — neue Nachricht, neues Token, neue Dateioperation.
	 *
	 * Der Takt kommt von `tick` (1 s), solange etwas läuft: Bei jedem einzelnen
	 * Token zu scrollen ruckelt sichtbar, einmal pro Sekunde folgt die Ansicht
	 * ruhig mit. `behavior: "auto"` statt „smooth“, weil sich sonst mehrere
	 * angefangene Bewegungen überlagern und das Bild zittert.
	 */
	/**
	 * Klebt die Ansicht am unteren Rand? Nur dann darf sie automatisch
	 * nachziehen. Sobald jemand nach oben scrollt, gehört der Verlauf ihm —
	 * auch mitten in einem laufenden Auftrag.
	 */
	const stickToBottom = useRef(true)

	/** Toleranz in Pixeln: ein paar Pixel Abstand gelten noch als „unten“. */
	const BOTTOM_EPS = 64

	const onLogScroll = useCallback(() => {
		const el = logRef.current
		if (!el) {
			return
		}
		stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPS
	}, [])

	/**
	 * Ans Ende springen — **nur den Verlauf**, nie die Seite. `scrollIntoView`
	 * bewegt jeden scrollbaren Vorfahren mit; dadurch sprang die ganze Ansicht.
	 *
	 * Ohne `force` bewegt sich gar nichts, solange die Leserin oben steht.
	 */
	const scrollToEnd = useCallback((force = false) => {
		const el = logRef.current
		if (!el || (!force && !stickToBottom.current)) {
			return
		}
		stickToBottom.current = true
		el.scrollTop = el.scrollHeight
	}, [])

	// Chatwechsel: neuer Verlauf, neue Ausgangslage — immer ganz unten anfangen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Chatwechsel als Auslöser
	useEffect(() => {
		stickToBottom.current = true
		scrollToEnd(true)
	}, [chatId, scrollToEnd])

	// Neue Nachricht: nachziehen, aber nur wenn die Ansicht ohnehin unten steht.
	useEffect(() => {
		if (turns.length > 0) {
			scrollToEnd()
		}
	}, [turns.length, scrollToEnd])

	/**
	 * Mitlaufen **nur, solange gearbeitet wird** — und nur, solange niemand
	 * selbst gescrollt hat. Wer nach oben geht, um die Antwort noch einmal zu
	 * lesen, darf nicht wieder nach unten gerissen werden.
	 */
	// `tick` ist der Herzschlag des Live-Streams: Er taktet das Nachziehen,
	// ohne selbst gelesen zu werden.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Taktgeber als Auslöser
	useEffect(() => {
		if (!running) {
			return
		}
		scrollToEnd()
	}, [tick, running, scrollToEnd])

	/**
	 * Vorschau der Kette, während getippt wird. Entprellt, weil jede Anfrage
	 * das Scoring über alle Spezialisten laufen lässt — und weil eine Vorschau,
	 * die bei jedem Buchstaben zuckt, unruhiger ist als hilfreich.
	 */
	useEffect(() => {
		const text = input.trim()
		if (text.length < 12) {
			setPlan([])
			return
		}
		const id = setTimeout(() => {
			api
				.post<{ steps: SwarmStep[] }>("/api/swarms/plan", { prompt: text, agentMode: target !== "answer" })
				.then((r) => setPlan(r.steps))
				.catch(() => setPlan([]))
		}, 400)
		return () => clearTimeout(id)
	}, [input, target])

	/**
	 * Wie viele Modelle würde dieser Prompt überhaupt noch erreichen?
	 *
	 * Das Kontext-Gate schliesst jedes Modell aus, dessen Fenster kleiner ist als
	 * das 1,2-Fache der geschätzten Token. Ein langer Prompt — eine eingefügte
	 * Dokumentation, ein mitgesendeter Verlauf — dünnt das Feld also aus, ohne
	 * dass man es merkt. Bis es niemanden mehr trifft und der Auftrag mit
	 * „Keine Instanz verfügbar" scheitert. Diese Rechnung steht deshalb **vor**
	 * dem Absenden.
	 */
	const kontextLage = useMemo(() => {
		const verlauf = turns
			.filter((t) => t.status === "done")
			.map((t) => ({ prompt: t.prompt, answer: t.answer }))
		const text = keepContext ? withHistory(input, verlauf) : input
		if (text.trim().length === 0) {
			return null
		}
		const estTokens = estimateTokens(text)
		const nötig = Math.ceil(estTokens * 1.2)
		const aktiv = instances.filter((i) => i.enabled)
		const passend = aktiv.filter((i) => i.contextWindow >= nötig)
		return { estTokens, nötig, aktiv: aktiv.length, passend: passend.length }
	}, [input, keepContext, turns, instances])

	const runOf = (taskId: string) => Object.values(live).find((r) => r.taskId === taskId)
	const instanceOf = (id?: string) => instances.find((i) => i.id === id)
	const providerLabel = (providerId?: string) => providers.find((p) => p.id === providerId)?.label
	/**
	 * Wer rechnet gerade woran? Live aus dem Stream, sonst aus dem Verlauf.
	 *
	 * Wenn bekannt ist, auf **welchem Rechner** das Modell tatsächlich läuft,
	 * steht der dort — und der Provider nur als Weg dorthin. LM Studio reicht
	 * mit „LM Link" fremde Modelle durch: Der Endpunkt heisst dann `MacDani`,
	 * gerechnet wird auf `LokalAI_Server1`. Die alte Anzeige nannte den
	 * Briefkasten, nicht den Empfänger.
	 */
	const workerOf = (turn: Turn): { model?: string; host?: string } => {
		const run = runOf(turn.taskId)
		const inst = instanceOf(run?.instanceId)
		if (inst) {
			const weg = providerLabel(inst.providerId)
			const geraet = inst.deviceName
			return {
				model: inst.displayName,
				host: geraet && geraet !== weg ? `${geraet} · über ${weg}` : weg,
			}
		}
		return { model: turn.modelName ?? undefined, host: turn.providerLabel ?? undefined }
	}

	const send = async () => {
		const text = input.trim()
		if ((!text && bilder.length === 0) || busy) {
			return
		}
		if (compareMode) {
			await sendCompare(text)
			return
		}
		if (target === "repo" && !repoId) {
			setLastError(
				repos.length === 0
					? "Kein Repository angebunden — unter „GitHub“ verbinden, dann erscheint es hier"
					: "Bitte ein Repository wählen — oder Ziel auf „Projekt anlegen“ stellen",
			)
			return
		}
		setInput("")
		setBusy(true)
		// Eigene Nachricht: dorthin springen, auch wenn gerade oben gelesen wurde.
		scrollToEnd(true)
		try {
			const history = turns
				.filter((t) => t.status === "done")
				.map((t) => ({ prompt: t.prompt, answer: t.answer }))
			// Wer wird gebraucht? Meist mehr als einer — klären, bauen, prüfen.
			// Fällt die Planung leer aus, bleibt es bei der Einzel-Zuordnung.
			const plan = await api
				.post<{ steps: SwarmStep[] }>("/api/swarms/plan", { prompt: text, agentMode: target !== "answer" })
				.catch(() => ({ steps: [] as SwarmStep[] }))
			// Im Schnellmodus arbeitet immer nur einer — ein Schwarm wäre das
			// Gegenteil von schnell.
			const kette =
				swarmMode && !fastMode
					? plan.steps.map((s) => s.agentId)
					: plan.steps.slice(0, 1).map((s) => s.agentId)
			// Stufen statt Perlenschnur: Was fachlich nebeneinander liegt (bauen
			// und Daten, prüfen und dokumentieren), läuft gleichzeitig — auf
			// allen angebundenen Rechnern statt nacheinander auf einem.
			const stufen = swarmMode && !fastMode ? stagesOf(plan.steps) : kette.map((id) => [id])

			const task = await api.post<{ id: string }>("/api/tasks", {
				title: titleFrom(text || "(Bild)"),
				prompt: text ? (keepContext ? withHistory(text, history) : text) : "Beschreibe das Bild",
				// T1-2 Vision: Bilder wandern als Base64-Anhänge mit — der Core
				// macht daraus `ContentPart[]` und routet nur auf `vision`-Modelle.
				attachments: bilder.map((b) => ({
					filename: b.filename,
					mime: b.mime,
					dataB64: b.dataUri.split(";base64,")[1] ?? "",
				})),
				metadata: {
					privacy: cloudErlaubt ? "any" : "local-only",
					mode: "auto",
					// Agentik-Modus: nur wenn der Spezialist Dateien anfassen soll.
					agentMode: target !== "answer",
					speed: fastMode ? "fast" : "normal",
					chatId,
					...(kette.length > 1
						? {
								chain: {
									id: crypto.randomUUID(),
									agentIds: kette,
									index: 0,
									stages: stufen,
									stage: 0,
									goal: text,
								},
							}
						: {}),
				},
				assignmentMode: kette.length > 0 ? "agent" : "auto",
				agentId: kette[0],
			})
			setBilder([])
			setPending((p) => [
				...p,
				{
					taskId: task.id,
					prompt: text || "(Bild)",
					status: "running",
					createdAt: new Date().toISOString(),
					agentMode: target !== "answer",
					// Was hier entsteht, ist immer eine getippte Nachricht — eine
					// Übergabe legt der Core an, nicht die Oberfläche.
					chain: null,
					repoId: target === "repo" ? repoId : null,
					agentName: null,
					agentReason: null,
					modelName: null,
					providerLabel: null,
					answer: "",
					error: null,
					files: [],
					attachments: bilder.map((b) => ({
						filename: b.filename,
						mime: b.mime,
						sizeBytes: b.sizeBytes,
						dataUri: b.dataUri,
					})),
					toolCalls: [],
				},
			])
			if (target === "repo") {
				await api.put(`/api/tasks/${task.id}/repo`, { repoId })
			}
			await api.post(`/api/tasks/${task.id}/start`)
			await loadChats()
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			setLastError(message)
		} finally {
			setBusy(false)
		}
	}

	const cancel = async (taskId: string) => {
		try {
			await api.post(`/api/tasks/${taskId}/cancel`)
			await loadChats()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	/**
	 * A/B-Vergleich starten (T1-1): derselbe Auftrag, 2–4 gewählte Modelle.
	 *
	 * Der Core legt eine Task pro Instanz an, gepinnt an die jeweilige Spalte,
	 * verbunden durch `compareId` — und startet sie alle. Die Spalten erscheinen
	 * im Verlauf nebeneinander, live über den SSE-Stream.
	 */
	const sendCompare = async (text: string) => {
		if (compareIds.length < 2) {
			setLastError("Vergleich: mindestens zwei Modelle wählen — sonst fehlt die Vergleichsseite")
			return
		}
		if (compareIds.length > 4) {
			setLastError("Vergleich: höchstens vier Modelle — mehr Spalten passen nicht in die Ansicht")
			return
		}
		setInput("")
		setBusy(true)
		scrollToEnd(true)
		try {
			const res = await api.post<{
				compareId: string
				tasks: { taskId: string; instanceId: string; started: boolean; reason?: string }[]
			}>("/api/compare", {
				prompt: text,
				title: titleFrom(text),
				instanceIds: compareIds,
				chatId,
			})
			const started = res.tasks.filter((t) => t.started).length
			const failed = res.tasks.filter((t) => !t.started)
			if (started === 0) {
				const why = failed
					.map((f) => f.reason)
					.filter(Boolean)
					.join(" · ")
				setLastError(`Keine Spalte konnte starten${why ? ` — ${why}` : ""}`)
				return
			}
			if (failed.length > 0) {
				setLastError(`${started} von ${res.tasks.length} Spalten gestartet — ${failed.length} fehlgeschlagen`)
			}
			// Der Verlauf lädt die Spalten aus dem Core (über `chatId`); ein
			// optimistischer Eintrag würde nur doppelte Zeilen erzeugen.
			await loadChats()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	/**
	 * Einen abgebrochenen oder steckengebliebenen Lauf fortsetzen.
	 *
	 * Der Arbeitsstand ist nicht verloren — gelesene Dateien, geschriebene
	 * Änderungen und die halbe Antwort liegen vor. Der Core legt daraus eine
	 * neue Task im **selben** Arbeitsverzeichnis an.
	 */
	const resume = async (taskId: string) => {
		try {
			await api.post(`/api/tasks/${taskId}/resume`)
			await loadChats()
			scrollToEnd(true)
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	/** Ein ganzes Gespräch löschen — mit Rückfrage, es ist unwiderruflich. */
	const removeChat = async (chat: ChatSummary) => {
		if (!window.confirm(`„${chat.title}“ mit ${chat.turns.length} Nachricht(en) endgültig löschen?`)) {
			return
		}
		try {
			await api.del(`/api/chats/${chat.chatId}`)
			if (chat.chatId === chatId) {
				setChatId(crypto.randomUUID())
				setPending([])
			}
			await loadChats()
		} catch (e) {
			setLastError(e instanceof Error ? e.message : String(e))
		}
	}

	const toggleHistory = () => {
		setHistoryOpen((open) => {
			try {
				window.localStorage.setItem("diriz_chat_history", open ? "0" : "1")
			} catch {
				// Ohne Speicher gilt die Wahl eben nur für diese Sitzung.
			}
			return !open
		})
	}

	const newChat = () => {
		setChatId(crypto.randomUUID())
		setPending([])
		setInput("")
	}

	return (
		<div className="fade-in chat-view">
			<div className="page-head">
				<div>
					<h1>Chat</h1>
					<p className="page-sub">
						Beschreib die Aufgabe. DiriZ wählt automatisch den passenden Spezialisten aus {agents.length} und
						arbeitet damit — antworten, ein Projekt anlegen oder ein Repository ändern.
					</p>
				</div>
				<div className="page-actions">
					<button
						type="button"
						className="btn"
						onClick={toggleHistory}
						aria-expanded={historyOpen}
						aria-controls="chat-history"
					>
						<IconChat size={15} />
						Verlauf{chats.length > 0 ? ` (${chats.length})` : ""}
					</button>
					<button type="button" className="btn" onClick={newChat}>
						<IconPlus size={15} />
						Neuer Chat
					</button>
				</div>
			</div>

			{!connected && (
				<div className="banner error" role="alert">
					<IconAlert size={17} />
					<span className="banner-text">
						Keine Verbindung zum DiriZ Core. Ohne ihn kann keine Aufgabe laufen — starte ihn mit{" "}
						<code>npm run serve</code>.
					</span>
				</div>
			)}

			<div className={`chat-layout ${historyOpen ? "with-history" : ""}`}>
				{historyOpen && (
					<aside className="chat-history" id="chat-history" aria-label="Bisherige Gespräche">
						<div className="chat-history-head">Verlauf</div>
						{chats.length === 0 && <p className="field-hint">Noch keine Gespräche.</p>}
						{chats.map((c) => (
							<div key={c.chatId} className={`chat-history-row ${c.chatId === chatId ? "active" : ""}`}>
								<button
									type="button"
									className="chat-history-item"
									onClick={() => {
										setChatId(c.chatId)
										setPending([])
									}}
								>
									<span className="chat-history-title">{c.title}</span>
									<span className="chat-history-meta">
										{c.turns.length} Nachricht{c.turns.length === 1 ? "" : "en"} ·{" "}
										{new Date(c.updatedAt).toLocaleString("de-CH", {
											day: "2-digit",
											month: "2-digit",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</span>
								</button>
								<button
									type="button"
									className="btn ghost sm chat-history-del"
									onClick={() => void removeChat(c)}
									aria-label={`Gespräch „${c.title}“ löschen`}
									title="Gespräch löschen"
								>
									<IconTrash size={13} />
								</button>
							</div>
						))}
					</aside>
				)}

				<div className="chat-main">
					<div className="chat-log" ref={logRef} onScroll={onLogScroll}>
						{turns.length === 0 && (
							<div className="empty">
								<span className="icon-chip">
									<IconChat size={20} />
								</span>
								<div className="empty-title">Noch keine Nachricht</div>
								<p>
									Zum Beispiel: „Ich möchte eine Webseite für eine Autogarage in Luzern“, „Der Import stürzt
									mit einer Exception ab, finde die Ursache“ oder „Prüfe die Anmeldung auf SQL-Injection“.
								</p>
							</div>
						)}

						{/* A/B-Vergleich (T1-1): Die erste Spalte eines Duells rendert das
				    Panel, die übrigen Spalten mit derselben `compareId`
				    verschwinden — sonst stünde jede Antwort doppelt. */}
						{turns.map((turn) => {
							const run = runOf(turn.taskId)
							const compareGroup = compareGroupOf.get(turn.taskId)
							if (compareGroup) {
								if (turn.taskId !== compareGroup[0]?.taskId) {
									return null
								}
								return (
									<div key={turn.taskId} className="chat-turn">
										<ComparePanel
											turns={compareGroup}
											runOf={(id) => {
												const r = runOf(id)
												return r
													? {
															status: r.status,
															startedAt: r.startedAt,
															firstActivityAt: r.firstActivityAt,
															text: r.text,
															usage: r.usage,
														}
													: undefined
											}}
											workerOf={workerOf}
											onCancel={(taskId) => void cancel(taskId)}
										/>
									</div>
								)
							}
							const answer = run?.text || turn.answer
							const worker = workerOf(turn)
							const isRunning = run?.status === "running" || turn.status === "running"
							// „Lädt“ heisst: noch kein Lebenszeichen — kein Text, kein
							// Tool-Aufruf, kein Gedankengang. Im Agentik-Modus beginnt ein
							// Modell oft mit `list_files` und schreibt minutenlang keine Zeile.
							const loading = isRunning && run !== undefined && run.firstActivityAt === undefined
							const loadMs =
								run?.startedAt !== undefined ? (run.firstActivityAt ?? Date.now()) - run.startedAt : undefined
							// Live bevorzugt (sofortige Anzeige), sonst der persistierte
							// Stand — nach einem Neuladen ist genau der alles, was es gibt.
							const liveOps = run?.toolOps ?? []
							const toolOps = liveOps.length >= turn.toolCalls.length ? liveOps : turn.toolCalls
							const lastTool = toolOps.at(-1)
							// Gesamtdauer mitlaufen lassen: Ohne sie wirkt ein Lauf, der
							// minutenlang nur nachdenkt, wie ein hängendes Programm.
							const elapsedMs = run?.startedAt !== undefined ? Date.now() - run.startedAt : undefined
							const files = turn.files
							const badges = toolBadges(toolOps)
							// Fachbereich aus dem Katalog — er ordnet den Spezialisten ein,
							// ohne dass man seine Beschreibung lesen muss.
							const agentId = agents.find((a) => a.name === turn.agentName)?.id
							const discipline = agentId
								? findBlueprint(agentId.replace(/^agent-/, ""))?.discipline
								: undefined
							// Eine Übergabe ist keine getippte Nachricht: Sie kommt vom
							// vorigen Spezialisten und wird als Markdown gezeigt.
							// Schritt 1 ist die getippte Nachricht selbst — erst ab Schritt 2
							// übergibt ein Spezialist an den nächsten.
							const isHandoff = (turn.chain?.step ?? 1) > 1
							const handoff = isHandoff ? splitHandoff(turn.prompt) : null
							return (
								<div key={turn.taskId} className="chat-turn">
									<div className={`chat-msg user ${handoff ? "handoff" : ""}`}>
										<div className="chat-role">
											{isHandoff && turn.chain
												? `Übergabe · Stufe ${turn.chain.step} von ${turn.chain.total}`
												: "Du"}
										</div>
										{/* T1-2 Vision: die gesendeten Bilder — als Thumbnails
											über dem Text, damit klar ist, was das Modell sah. */}
										{turn.attachments && turn.attachments.length > 0 && (
											<div className="chat-images">
												{turn.attachments.map((a) => (
													<img
														key={a.filename || a.dataUri.slice(0, 40)}
														src={a.dataUri}
														alt={a.filename || "Anhang"}
														className="chat-image"
														title={`${a.filename} · ${(a.sizeBytes / 1024).toFixed(0)} kB`}
													/>
												))}
											</div>
										)}
										{handoff ? (
											<div className="chat-body md">
												<div className="handoff-part">
													<div className="handoff-label">Ursprünglicher Auftrag</div>
													<Markdown source={handoff.goal} />
												</div>
												<details className="accordion handoff-prior">
													<summary>
														<IconChevronRight size={13} className="accordion-arrow" />
														<span>{handoff.priorTitle}</span>
														<span className="faint">
															{handoff.prior.length.toLocaleString("de-CH")} Zeichen
														</span>
													</summary>
													<div className="handoff-prior-body">
														<Markdown source={handoff.prior} />
													</div>
												</details>
												<div className="handoff-part">
													<div className="handoff-label">Deine Aufgabe</div>
													<Markdown source={handoff.task} />
												</div>
											</div>
										) : (
											<div className="chat-body">{turn.prompt}</div>
										)}
									</div>

									<div className={`chat-msg agent ${isRunning ? "live" : ""}`} data-status={turn.status}>
										{/* Der Kopf klebt oben: Bei einer langen Antwort weiss man
										    sonst nach zwei Bildschirmen nicht mehr, wer gerade spricht. */}
										<div className="chat-head">
											<span className="chat-avatar" aria-hidden="true">
												<IconAgents size={13} />
											</span>
											<div className="chat-ident">
												<div className="chat-name">
													<span className="chat-name-text">
														{turn.agentName ??
															(isRunning && !run ? "Spezialist wird gewählt …" : "Freies Routing")}
													</span>
													{discipline && <span className="badge soft">{discipline}</span>}
												</div>
												{worker.model && (
													<div
														className="chat-worker"
														title={worker.host ? `${worker.model} auf ${worker.host}` : worker.model}
													>
														<IconServer size={11} />
														<span className="mono">{worker.model}</span>
														{worker.host && (
															<>
																<span className="chat-at">auf</span>
																<span className="mono">{worker.host}</span>
															</>
														)}
													</div>
												)}
											</div>
											<span className={`pill ${STATUS_PILL[turn.status] ?? "info"}`}>
												{STATUS_LABEL[turn.status] ?? turn.status}
											</span>
											{/* Nur ein Symbol: Die Beschriftung drängte auf schmalen
											    Fenstern Name und Modell aus der Kopfzeile. */}
											{isRunning && (
												<button
													type="button"
													className="btn ghost sm icon-only"
													title="Abbrechen"
													aria-label="Abbrechen"
													onClick={() => void cancel(turn.taskId)}
												>
													<IconStop size={13} />
												</button>
											)}
											{/* Steckengeblieben oder abgebrochen: Der Stand liegt vor,
											    also lässt er sich fortsetzen statt neu zu beginnen. */}
											{!isRunning &&
												(turn.status === "cancelled" ||
													turn.status === "failed" ||
													answer.includes("[Agentik:")) && (
													<button
														type="button"
														className="btn ghost sm icon-only"
														title="Fortsetzen — neue Task im selben Arbeitsverzeichnis, mit dem bisherigen Stand als Vorarbeit"
														aria-label="Fortsetzen"
														onClick={() => void resume(turn.taskId)}
													>
														<IconRefresh size={13} />
													</button>
												)}
										</div>

										<div className="chat-agent-body">
											{turn.agentReason && (
												<div className="chat-reason clamp" title={turn.agentReason}>
													{turn.agentReason}
												</div>
											)}

											{/* Was passiert gerade? Ohne diese Zeile sieht ein Modell,
										    das lädt, aus wie ein Programm, das hängt. */}
											{isRunning && (
												<div className="chat-phase" data-tick={tick}>
													{loading ? (
														<>
															<span className="dot-pulse" />
															Modell wird geladen{loadMs !== undefined ? ` … ${duration(loadMs)}` : " …"}
															<span className="field-hint">
																Beim ersten Aufruf wandert das Modell in den Grafikspeicher — das dauert bei
																grossen Modellen Minuten.
															</span>
														</>
													) : (
														<>
															<span className="dot-pulse" />
															<span className="chat-phase-what">
																{run?.text
																	? "schreibt …"
																	: lastTool
																		? `arbeitet mit Dateien … ${lastTool.name}`
																		: run?.reasoning
																			? "denkt nach …"
																			: "arbeitet …"}
															</span>
															{/* Zahlen als eigene Chips statt als ein durchlaufender Satz: So
															    findet das Auge das Tempo, ohne die Zeile zu lesen. */}
															{elapsedMs !== undefined && (
																<span className="chat-stat mono">{duration(elapsedMs)}</span>
															)}
															{run?.usage ? (
																<span className="chat-stat mono">{run.usage.tokensOut} Tok</span>
															) : null}
															{run?.usage?.tps ? (
																<span className="chat-stat mono">{run.usage.tps.toFixed(1)} Tok/s</span>
															) : null}
															{loadMs !== undefined && (
																<span className="chat-stat mono" title="Ladezeit des Modells">
																	Laden {seconds(loadMs)}
																</span>
															)}
														</>
													)}
												</div>
											)}

											{run && run.failovers.length > 0 && (
												<div className="chat-reason">Wechsel: {run.failovers.join(" · ")}</div>
											)}

											{badges.length > 0 && <ToolStrip badges={badges} total={toolOps.length} />}

											{/*
											 * Der Gedankengang bleibt zugeklappt: Er ist oft zehnmal
											 * länger als die Antwort und würde sie sonst begraben.
											 * Wer wissen will, wie das Modell zum Ergebnis kam, klappt auf.
											 */}
											{run?.reasoning && (
												<details className="accordion chat-thoughts">
													<summary>
														<IconChevronRight size={13} className="accordion-arrow" />
														<span>Gedankengang</span>
														<span className="badge">
															{run.reasoning.length.toLocaleString("de-CH")} Zeichen
														</span>
														{isRunning && <span className="dot-pulse" />}
													</summary>
													{/* Auch der Gedankengang enthält Code — er wird deshalb wie
												    jede andere Modellausgabe gerendert, mit zugeklappten
												    Code-Blöcken. Sonst flutet ein aufgeklappter Gedankengang
												    den Verlauf erneut. */}
													<div className="output md">
														<Markdown source={run.reasoning} />
													</div>
												</details>
											)}

											{answer ? (
												<div className={`chat-answer ${isRunning ? "streaming" : ""}`}>
													<Markdown source={answer} />
												</div>
											) : (
												turn.status === "failed" && null
											)}

											{turn.error && <div className="chat-error">{turn.error}</div>}

											{/* Erst die Arbeit … */}
											{turn.repoId && <ChatDiff taskId={turn.taskId} refreshKey={toolOps.length} />}

											{files.length > 0 && (
												<div className="chat-files">
													<strong>Dateien:</strong>{" "}
													{files.map((f) => (
														<span key={f.relPath} className="pill no-dot">
															{f.relPath}
														</span>
													))}
												</div>
											)}

											{/* … und ganz zum Schluss: wohin sie gegangen ist. */}
											{turn.repoId && <ChatGitHub taskId={turn.taskId} refreshKey={toolOps.length} />}
										</div>
									</div>
								</div>
							)
						})}
						<div ref={endRef} />
					</div>

					<form
						className="chat-composer card"
						onSubmit={(e) => {
							// Enter im Textfeld sendet selbst (`onKeyDown`) — der
							// Form-Submit bleibt ein No-Op, sonst würde der Browser
							// die Seite neu laden.
							e.preventDefault()
						}}
						onDragOver={(e) => {
							// T1-2 Vision: Drop-Ziel kennzeichnen — ohne preventDefault
							// würde der Browser die Datei ausserhalb des Browsers öffnen.
							e.preventDefault()
						}}
						onDrop={(e) => {
							e.preventDefault()
							for (const f of Array.from(e.dataTransfer.files)) {
								if (f.type.startsWith("image/")) {
									addBild(f)
								}
							}
						}}
					>
						<div className="chat-targets">
							{TARGETS.map((t) => (
								<button
									key={t.id}
									type="button"
									className={`btn sm ${target === t.id ? "primary" : ""}`}
									onClick={() => setTarget(t.id)}
									aria-pressed={target === t.id}
									// Die Erklärung als Tooltip statt als Dauerzeile: Sie kostete
									// drei Zeilen Höhe und sagte immer dasselbe.
									title={t.hint}
								>
									{t.id === "answer" && <IconChat size={14} />}
									{t.id === "workspace" && <IconWorkspace size={14} />}
									{t.id === "repo" && <IconGitBranch size={14} />}
									{t.label}
								</button>
							))}
							{target === "repo" &&
								(repos.length > 0 ? (
									<select value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository">
										<option value="">Repository wählen …</option>
										{repos.map((r) => (
											<option key={r.id} value={r.id} disabled={!r.localPath}>
												{r.fullName}
												{r.localPath ? "" : " (wird geklont)"}
											</option>
										))}
									</select>
								) : (
									// Ohne diesen Hinweis steht hier nur eine leere Auswahl, und
									// niemand erfährt, dass ein Repository erst angebunden werden muss.
									<a className="btn" href="/github">
										<IconGitBranch size={14} />
										Kein Repository angebunden — jetzt verbinden
									</a>
								))}
							<label
								className="chat-context"
								title="Swarm: mehrere Spezialisten nacheinander, automatisch zusammengestellt"
							>
								<input
									type="checkbox"
									checked={swarmMode && !fastMode}
									disabled={fastMode}
									onChange={(e) => setSwarmMode(e.target.checked)}
								/>
								Swarm
							</label>
							<label
								className="chat-context"
								title="Schnellmodus: ein Spezialist auf dem nachweislich schnellsten Modell — für kleine Korrekturen"
							>
								<input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} />
								Schnell
							</label>
							<label
								className="chat-context"
								title="Erlaubt Cloud-Anbieter (OpenRouter, OpenAI) für diese Unterhaltung. Aus = ausschliesslich deine eigenen Rechner; dein Code verlässt das Haus nicht."
							>
								<input
									type="checkbox"
									checked={cloudErlaubt}
									onChange={(e) => {
										setCloudErlaubt(e.target.checked)
										localStorage.setItem("diriz.cloudErlaubt", e.target.checked ? "1" : "0")
									}}
								/>
								Cloud
							</label>
							<label className="chat-context">
								<input
									type="checkbox"
									checked={keepContext}
									onChange={(e) => setKeepContext(e.target.checked)}
								/>
								Verlauf mitsenden
							</label>
							{/* A/B-Vergleich (T1-1): derselbe Auftrag parallel auf 2–4 gewählten
							    Modellen — die Spalten erscheinen nebeneinander, live. */}
							<label
								className="chat-context"
								title="Vergleich: derselbe Auftrag parallel auf 2–4 Modellen — Antwort, Tempo, Kosten und Diff nebeneinander"
							>
								<input
									type="checkbox"
									checked={compareMode}
									onChange={(e) => {
										setCompareMode(e.target.checked)
										if (!e.target.checked) {
											setCompareIds([])
										}
									}}
								/>
								Vergleich
							</label>
							{compareMode && (
								<div className="compare-picker">
									{instances
										.filter((i) => i.enabled)
										.slice(0, 12)
										.map((i) => {
											const on = compareIds.includes(i.id)
											const atLimit = !on && compareIds.length >= 4
											return (
												<button
													key={i.id}
													type="button"
													className={`chip ${on ? "on" : ""}`}
													aria-pressed={on}
													disabled={atLimit}
													title={
														i.displayName +
														(i.deviceName ? ` · ${i.deviceName}` : "") +
														(i.contextWindow ? ` · ${Math.round(i.contextWindow / 1000)}k Kontext` : "")
													}
													onClick={() => {
														if (on) {
															setCompareIds((ids) => ids.filter((x) => x !== i.id))
														} else if (compareIds.length < 4) {
															setCompareIds((ids) => [...ids, i.id])
														}
													}}
												>
													{on ? "✓ " : ""}
													{i.displayName}
												</button>
											)
										})}
									<span className="faint compare-picker-hint">
										{compareIds.length} / 4 gewählt — mindestens 2, höchstens 4
									</span>
								</div>
							)}
						</div>
						{plan.length > 0 && (
							<div className="chat-plan">
								<span className="chat-tools-label">
									{fastMode
										? "Schnell · ein Spezialist"
										: swarmMode && plan.length > 1
											? `Swarm · ${plan.length} Schritte`
											: "Spezialist"}
								</span>
								{(swarmMode && !fastMode ? plan : plan.slice(0, 1)).map((s, i) => (
									<span key={s.agentId} className="plan-step" title={s.reasons.join(" · ")}>
										{swarmMode && !fastMode && plan.length > 1 && <span className="plan-index">{i + 1}</span>}
										{s.name}
									</span>
								))}
							</div>
						)}
						{/* Der Prompt dünnt das Feld aus — sichtbar machen, bevor er weg ist. */}
						{kontextLage && kontextLage.passend < kontextLage.aktiv && (
							<div className="chat-nudge">
								<IconAlert size={14} />
								<span>
									Langer Auftrag: ≈{kontextLage.estTokens.toLocaleString("de-CH")} Token — davon erreicht er{" "}
									<strong>
										{kontextLage.passend} von {kontextLage.aktiv}
									</strong>{" "}
									Modellen. Die übrigen haben ein zu kleines Kontext-Fenster.
									{kontextLage.passend === 0 && " So kann der Auftrag nicht starten."}
								</span>
								{keepContext && (
									<button type="button" className="btn sm" onClick={() => setKeepContext(false)}>
										Verlauf nicht mitsenden
									</button>
								)}
							</div>
						)}
						{target === "answer" && NEEDS_FILES.test(input) && (
							<div className="chat-nudge">
								<IconAlert size={14} />
								<span>
									Der Auftrag klingt nach Arbeit am echten Code. „Nur antworten“ hat keinen Dateizugriff — die
									Antwort bliebe allgemein.
								</span>
								<button type="button" className="btn sm" onClick={() => setTarget("repo")}>
									<IconGitBranch size={13} />
									Repository ändern
								</button>
								<button type="button" className="btn sm" onClick={() => setTarget("workspace")}>
									<IconWorkspace size={13} />
									Projekt anlegen
								</button>
							</div>
						)}
						<div className="chat-input-row">
							<textarea
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault()
										void send()
									}
								}}
								onPaste={(e) => {
									// T1-2 Vision: Bild aus der Zwischenablage — Strg+V
									// im Textfeld klebt es sonst als leerer Text.
									const items = e.clipboardData?.items
									if (!items) {
										return
									}
									for (const item of Array.from(items)) {
										if (item.kind === "file" && item.type.startsWith("image/")) {
											const file = item.getAsFile()
											if (file) {
												e.preventDefault()
												addBild(file)
												return
											}
										}
									}
								}}
								rows={2}
								placeholder="Aufgabe beschreiben … (Enter sendet, Umschalt+Enter neue Zeile)"
							/>
							<div className="chat-input-actions">
								{/* T1-2 Vision: Bild anhängen — File-Picker, Paste und
									Drag&Drop führen alle in `bilder` zusammen. */}
								<input
									ref={(el) => {
										bildInputRef.current = el
									}}
									type="file"
									accept="image/*"
									multiple
									className="sr-only"
									onChange={(e) => {
										const list = e.target.files
										if (list) {
											for (const f of Array.from(list)) {
												addBild(f)
											}
										}
										e.target.value = ""
									}}
								/>
								<button
									type="button"
									className={`btn sm ${bilder.length > 0 ? "primary" : ""}`}
									onClick={() => bildInputRef.current?.click()}
									disabled={bilder.length >= 5}
									title="Bild anhängen (auch per Paste oder Ziehen) — maximal 5, je 8 MB"
								>
									<IconUpload size={14} />
									{bilder.length > 0 ? `${bilder.length} Bild${bilder.length > 1 ? "er" : ""}` : "Bild"}
								</button>
								<button
									type="button"
									className="btn primary chat-send"
									onClick={() => void send()}
									disabled={busy || !connected || (input.trim().length === 0 && bilder.length === 0)}
									title={compareMode ? "Vergleich starten (Enter)" : "Senden (Enter)"}
								>
									<IconPlay size={14} />
									{compareMode ? "Vergleich starten" : "Senden"}
								</button>
							</div>
						</div>
						{/* T1-2 Vision: Vorschau der angehängten Bilder — entfernen mit
							dem X, sonst geht das Bild mit der nächsten Nachricht mit. */}
						{bilder.length > 0 && (
							<div className="chat-image-previews">
								{(() => {
									// Namen können doppelt vorkommen (zwei Mal "Bild.png") —
									// ein Läufer zählt Vorkommen, damit die Keys eindeutig bleiben.
									const zähler = new Map<string, number>()
									return bilder.map((b, i) => {
										const name = b.filename || "bild"
										const n = (zähler.get(name) ?? 0) + 1
										zähler.set(name, n)
										return (
											<figure key={`${name}#${n}`} className="chat-image-preview">
												<img src={b.dataUri} alt={b.filename || "Bild"} />
												<figcaption>
													{b.filename} · {(b.sizeBytes / 1024).toFixed(0)} kB
												</figcaption>
												<button
													type="button"
													className="chat-image-remove"
													onClick={() => setBilder((all) => all.filter((_, j) => j !== i))}
													title="Bild entfernen"
												>
													×
												</button>
											</figure>
										)
									})
								})()}
							</div>
						)}
					</form>
				</div>
			</div>
		</div>
	)
}
