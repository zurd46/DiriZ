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

import { type FileDiff, findBlueprint, type GitStatus, type InstanceModel, type Repo } from "@diriz/shared"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import DiffView from "../components/DiffView.js"
import {
	IconAgents,
	IconAlert,
	IconChat,
	IconDoc,
	IconEdit,
	IconGitBranch,
	IconPlay,
	IconPlus,
	IconServer,
	IconStop,
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
	/** Gepinntes Repository — dann gibt es Diff, Commit und Push direkt hier. */
	repoId: string | null
	agentName: string | null
	agentReason: string | null
	modelName: string | null
	providerLabel: string | null
	answer: string
	error: string | null
	files: { relPath: string; size: number }[]
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
	write_file: "geschrieben",
}

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
function ToolStrip({ badges, total }: { badges: ToolBadge[]; total: number }) {
	const [alle, setAlle] = useState(false)
	const sichtbar = alle ? badges : badges.slice(0, 8)
	const rest = badges.length - sichtbar.length

	return (
		<div className="chat-tools">
			<span className="chat-tools-label">
				{total} Operation{total === 1 ? "" : "en"}
			</span>
			{sichtbar.map((b) => (
				<span key={b.id} className={`tool-badge ${b.ok ? "" : "err"} ${b.name}`} title={b.target || b.name}>
					{b.name === "write_file" ? <IconEdit size={11} /> : <IconDoc size={11} />}
					<span className="tool-verb">{TOOL_LABEL[b.name] ?? b.name}</span>
					{b.target && <span className="tool-target">{shortPath(b.target)}</span>}
					{b.count > 1 && <span className="tool-count">×{b.count}</span>}
				</span>
			))}
			{rest > 0 && (
				<button type="button" className="tool-more" onClick={() => setAlle(true)}>
					+{rest} weitere
				</button>
			)}
			{alle && badges.length > 8 && (
				<button type="button" className="tool-more" onClick={() => setAlle(false)}>
					weniger
				</button>
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
	useEffect(() => {
		if (turns.length === 0) {
			return
		}
		endRef.current?.scrollIntoView({ block: "end" })
	}, [turns.length, tick, running])

	const runOf = (taskId: string) => Object.values(live).find((r) => r.taskId === taskId)
	const instanceOf = (id?: string) => instances.find((i) => i.id === id)
	const providerLabel = (providerId?: string) => providers.find((p) => p.id === providerId)?.label

	/** Wer rechnet gerade woran? Live aus dem Stream, sonst aus dem Verlauf. */
	const workerOf = (turn: Turn): { model?: string; host?: string } => {
		const run = runOf(turn.taskId)
		const inst = instanceOf(run?.instanceId)
		if (inst) {
			return { model: inst.displayName, host: providerLabel(inst.providerId) }
		}
		return { model: turn.modelName ?? undefined, host: turn.providerLabel ?? undefined }
	}

	const send = async () => {
		const text = input.trim()
		if (!text || busy) {
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
		try {
			const history = turns
				.filter((t) => t.status === "done")
				.map((t) => ({ prompt: t.prompt, answer: t.answer }))
			const task = await api.post<{ id: string }>("/api/tasks", {
				title: titleFrom(text),
				prompt: keepContext ? withHistory(text, history) : text,
				metadata: {
					privacy: "local-only",
					mode: "auto",
					// Agentik-Modus: nur wenn der Spezialist Dateien anfassen soll.
					agentMode: target !== "answer",
					chatId,
				},
				assignmentMode: "auto",
			})
			setPending((p) => [
				...p,
				{
					taskId: task.id,
					prompt: text,
					status: "running",
					createdAt: new Date().toISOString(),
					agentMode: target !== "answer",
					repoId: target === "repo" ? repoId : null,
					agentName: null,
					agentReason: null,
					modelName: null,
					providerLabel: null,
					answer: "",
					error: null,
					files: [],
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

	const activeTarget = TARGETS.find((t) => t.id === target)

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
					<div className="chat-log">
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

						{turns.map((turn) => {
							const run = runOf(turn.taskId)
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
							return (
								<div key={turn.taskId} className="chat-turn">
									<div className="chat-msg user">
										<div className="chat-role">Du</div>
										<div className="chat-body">{turn.prompt}</div>
									</div>

									<div className="chat-msg agent">
										<div className="chat-head">
											<span className="chat-avatar" aria-hidden="true">
												<IconAgents size={16} />
											</span>
											<div className="chat-ident">
												<div className="chat-name">
													{turn.agentName ??
														(isRunning && !run ? "Spezialist wird gewählt …" : "Freies Routing")}
													{discipline && <span className="badge soft">{discipline}</span>}
												</div>
												{worker.model && (
													<div className="chat-worker">
														<IconServer size={12} />
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
											{isRunning && (
												<button
													type="button"
													className="btn ghost sm"
													onClick={() => void cancel(turn.taskId)}
												>
													<IconStop size={13} />
													Abbrechen
												</button>
											)}
										</div>

										{turn.agentReason && (
											<div className="chat-reason" title="Warum dieser Spezialist gewählt wurde">
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
														{run?.text
															? "schreibt …"
															: lastTool
																? `arbeitet mit Dateien … ${lastTool.name}`
																: run?.reasoning
																	? "denkt nach …"
																	: "arbeitet …"}
														{run?.usage ? ` ${run.usage.tokensOut} Tokens` : ""}
														{run?.usage?.tps ? ` · ${run.usage.tps.toFixed(1)} Tokens/s` : ""}
														{run?.reasoning ? ` · Gedankengang ${run.reasoning.length} Zeichen` : ""}
														{loadMs !== undefined ? ` · Ladezeit ${seconds(loadMs)}` : ""}
														{elapsedMs !== undefined ? ` · läuft seit ${duration(elapsedMs)}` : ""}
													</>
												)}
											</div>
										)}

										{run && run.failovers.length > 0 && (
											<div className="chat-reason">Wechsel: {run.failovers.join(" · ")}</div>
										)}

										{badges.length > 0 && <ToolStrip badges={badges} total={toolOps.length} />}

										{run?.reasoning && (
											<details className="chat-thoughts">
												<summary>Gedankengang ({run.reasoning.length} Zeichen)</summary>
												<pre className="output">{run.reasoning}</pre>
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
							)
						})}
						<div ref={endRef} />
					</div>

					<div className="chat-composer card">
						<div className="chat-targets">
							{TARGETS.map((t) => (
								<button
									key={t.id}
									type="button"
									className={`btn ${target === t.id ? "primary" : ""}`}
									onClick={() => setTarget(t.id)}
									aria-pressed={target === t.id}
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
							<label className="chat-context">
								<input
									type="checkbox"
									checked={keepContext}
									onChange={(e) => setKeepContext(e.target.checked)}
								/>
								Verlauf mitsenden
							</label>
						</div>
						{activeTarget && <p className="field-hint">{activeTarget.hint}</p>}
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
						<textarea
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault()
									void send()
								}
							}}
							rows={3}
							placeholder="Aufgabe beschreiben … (Enter sendet, Umschalt+Enter macht eine neue Zeile)"
						/>
						<div className="chat-actions">
							<button
								type="button"
								className="btn primary"
								onClick={() => void send()}
								disabled={busy || !connected || input.trim().length === 0}
							>
								<IconPlay size={14} />
								Senden
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
