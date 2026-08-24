/**
 * GitHub-Bereich einer Task (M10): Repository pinnen, Änderungen als Diff
 * ansehen, committen, pushen und einen Pull-Request öffnen.
 *
 * Die Task arbeitet in einem Git-Worktree des gepinnten Repositories — was das
 * Modell schreibt, ist damit eine echte Änderung am Projekt. Dieser Bereich
 * macht sie sichtbar und bringt sie zu GitHub.
 */

import type { FileDiff, GitStatus, Repo, Task } from "@diriz/shared"
import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"
import DiffView from "./DiffView.js"
import { IconArrowRight, IconCheckCircle, IconGitBranch, IconInfo, IconRefresh, IconUpload } from "./icons.js"

export default function TaskGitPanel({
	task,
	onTaskChanged,
	refreshKey,
}: {
	task: Task
	onTaskChanged?: () => void
	/**
	 * Ändert sich dieser Wert, lädt der Bereich Status und Diff neu. Der Chat
	 * zählt damit die Dateioperationen mit — so wächst der Diff live mit,
	 * während das Modell noch schreibt.
	 */
	refreshKey?: number
}) {
	const notify = useStore((s) => s.notify)
	const setLastError = useStore((s) => s.setLastError)

	const [repos, setRepos] = useState<Repo[] | null>(null)
	const [status, setStatus] = useState<GitStatus | null>(null)
	const [diff, setDiff] = useState<FileDiff[] | null>(null)
	const [busy, setBusy] = useState<string | undefined>()
	const [message, setMessage] = useState("")
	const [notice, setNotice] = useState<string | undefined>()

	const taskId = task.id
	const pinned = Boolean(task.repoId)

	const fail = useCallback(
		(e: unknown) => setLastError(e instanceof Error ? e.message : String(e)),
		[setLastError],
	)

	/** Verbundene Repositories für die Auswahl. */
	useEffect(() => {
		api
			.get<Repo[]>("/api/repos")
			.then(setRepos)
			.catch(() => setRepos([]))
	}, [])

	const reload = useCallback(async () => {
		if (!pinned) {
			setStatus(null)
			setDiff(null)
			return
		}
		try {
			const [s, d] = await Promise.all([
				api.get<GitStatus>(`/api/tasks/${taskId}/git`),
				api.get<{ files: FileDiff[] }>(`/api/tasks/${taskId}/git/diff`),
			])
			setStatus(s)
			setDiff(d.files)
		} catch (e) {
			// Ein noch nicht angelegter Arbeitsbereich ist kein Fehler, sondern ein Zustand.
			setStatus(null)
			setDiff(null)
			setNotice(e instanceof Error ? e.message : String(e))
		}
	}, [pinned, taskId])

	// `refreshKey` ist das Signal der Eltern-Ansicht („am Repository hat sich
	// etwas getan"), kein Wert, den dieser Effekt liest.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bewusstes Auslöser-Signal
	useEffect(() => {
		void reload()
	}, [reload, refreshKey])

	const run = async (label: string, fn: () => Promise<void>) => {
		setBusy(label)
		setNotice(undefined)
		try {
			await fn()
		} catch (e) {
			fail(e)
		} finally {
			setBusy(undefined)
		}
	}

	const pin = (repoId: string | null) =>
		run("pin", async () => {
			await api.put(`/api/tasks/${taskId}/repo`, { repoId })
			onTaskChanged?.()
			notify("success", repoId ? "Repository gepinnt — Arbeitsbereich steht bereit" : "Bindung gelöst")
			await reload()
		})

	const commit = () =>
		run("commit", async () => {
			const res = await api.post<{ shortSha: string; filesChanged: number }>(
				`/api/tasks/${taskId}/git/commit`,
				{ message: message.trim() || undefined },
			)
			notify("success", `Commit ${res.shortSha} — ${res.filesChanged} Datei(en)`)
			setMessage("")
			await reload()
		})

	const push = (toBase: boolean) =>
		run(toBase ? "push-base" : "push", async () => {
			const res = await api.post<{ branch: string; compareUrl?: string }>(`/api/tasks/${taskId}/git/push`, {
				toBase,
				message: message.trim() || undefined,
			})
			notify("success", `Gepusht nach ${res.branch}`)
			setMessage("")
			onTaskChanged?.()
			await reload()
		})

	const openPr = () =>
		run("pr", async () => {
			const res = await api.post<{ url: string; existed: boolean }>(
				`/api/tasks/${taskId}/git/pull-request`,
				{},
			)
			notify("success", res.existed ? "Pull-Request existierte bereits" : "Pull-Request geöffnet")
			onTaskChanged?.()
			window.open(res.url, "_blank", "noreferrer")
			await reload()
		})

	const rebase = () =>
		run("rebase", async () => {
			await api.post(`/api/tasks/${taskId}/git/rebase`, {})
			notify("success", "Auf den aktuellen Basis-Branch gehoben")
			await reload()
		})

	const repoList = repos ?? []

	return (
		<div className="card inset" style={{ marginTop: "var(--sp-3)" }}>
			<div className="card-head">
				<div className="card-title">
					<IconGitBranch size={16} />
					GitHub
				</div>
				{pinned && (
					<button
						type="button"
						className="btn ghost sm"
						onClick={() => void reload()}
						disabled={busy !== undefined}
					>
						<IconRefresh size={14} />
						Aktualisieren
					</button>
				)}
			</div>

			{/* ------------------------------ Repo pinnen ------------------------------ */}
			<div className="row" style={{ marginTop: "var(--sp-2)", flexWrap: "wrap" }}>
				<label className="field" style={{ minWidth: 240 }}>
					Repository
					<select
						value={task.repoId ?? ""}
						onChange={(e) => void pin(e.target.value || null)}
						disabled={busy !== undefined}
					>
						<option value="">— nicht gepinnt —</option>
						{repoList.map((r) => (
							<option key={r.id} value={r.id}>
								{r.fullName}
							</option>
						))}
					</select>
				</label>
				{status && (
					<span className="row tight text-sm" style={{ alignSelf: "center" }}>
						<span className="badge subtle mono">{status.baseBranch}</span>
						<IconArrowRight size={13} />
						<span className="badge accent mono">{status.workBranch}</span>
					</span>
				)}
			</div>

			{repoList.length === 0 && (
				<p className="hint" style={{ marginTop: "var(--sp-2)" }}>
					<IconInfo size={14} />
					<span>
						Noch kein Repository verbunden — unter <strong>GitHub</strong> eines hinzufügen.
					</span>
				</p>
			)}

			{!pinned ? null : notice && !status ? (
				<p className="hint" style={{ marginTop: "var(--sp-3)" }}>
					<IconInfo size={14} />
					<span>{notice}</span>
				</p>
			) : status ? (
				<>
					{/* ------------------------------- Übersicht ------------------------------ */}
					<div className="row tight" style={{ marginTop: "var(--sp-3)", flexWrap: "wrap" }}>
						<span className="badge">
							{status.files.length} {status.files.length === 1 ? "Datei" : "Dateien"}
						</span>
						{status.additions > 0 && <span className="badge ok">+{status.additions}</span>}
						{status.deletions > 0 && <span className="badge err">−{status.deletions}</span>}
						{status.commits.length > 0 && (
							<span className="badge subtle">
								{status.commits.length} Commit{status.commits.length === 1 ? "" : "s"}
							</span>
						)}
						{status.dirty && <span className="badge warn">nicht committet</span>}
						{status.pushed && (
							<span className="badge ok row tight">
								<IconCheckCircle size={13} />
								gepusht
							</span>
						)}
						{status.prUrl && (
							<a className="badge accent" href={status.prUrl} target="_blank" rel="noreferrer">
								Pull-Request
							</a>
						)}
					</div>

					{/* -------------------------------- Aktionen ------------------------------ */}
					<div className="row" style={{ marginTop: "var(--sp-3)", flexWrap: "wrap" }}>
						<label className="field" style={{ flex: 1, minWidth: 240 }}>
							Commit-Nachricht
							<input
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								placeholder={`DiriZ: ${task.title}`}
							/>
						</label>
					</div>
					<div className="row" style={{ marginTop: "var(--sp-2)", flexWrap: "wrap" }}>
						<button
							type="button"
							className="btn"
							onClick={() => void commit()}
							disabled={busy !== undefined || !status.dirty}
							title={status.dirty ? "Änderungen committen" : "Nichts zu committen"}
						>
							{busy === "commit" ? "…" : "Committen"}
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() => void push(false)}
							disabled={busy !== undefined || (status.files.length === 0 && !status.dirty)}
							title="Arbeitsbranch zu GitHub pushen (committet offene Änderungen mit)"
						>
							<IconUpload size={15} />
							{busy === "push" ? "…" : "Push"}
						</button>
						<button
							type="button"
							className="btn"
							onClick={() => void openPr()}
							disabled={busy !== undefined || !status.pushed}
							title={status.pushed ? "Pull-Request öffnen" : "Erst pushen"}
						>
							{busy === "pr" ? "…" : "Pull-Request"}
						</button>
						<button
							type="button"
							className="btn ghost"
							onClick={() => void rebase()}
							disabled={busy !== undefined || status.dirty}
							title="Arbeitsbranch auf den neuesten Stand des Basis-Branches heben"
						>
							Rebase
						</button>
						<button
							type="button"
							className="btn danger"
							onClick={() => {
								if (window.confirm(`Direkt auf ${status.baseBranch} pushen? Das umgeht jede Prüfung.`)) {
									void push(true)
								}
							}}
							disabled={busy !== undefined || (status.files.length === 0 && !status.dirty)}
							title={`Ohne Umweg auf ${status.baseBranch} pushen`}
						>
							{busy === "push-base" ? "…" : `Direkt auf ${status.baseBranch}`}
						</button>
					</div>

					{/* ---------------------------------- Diff -------------------------------- */}
					<div style={{ marginTop: "var(--sp-4)" }}>
						{diff === null ? <p className="faint">Lade Diff …</p> : <DiffView files={diff} />}
					</div>

					{status.commits.length > 0 && (
						<div style={{ marginTop: "var(--sp-4)" }}>
							<div className="field-hint">Commits auf diesem Branch</div>
							<ul className="commit-list">
								{status.commits.map((c) => (
									<li key={c.sha}>
										<span className="mono faint">{c.shortSha}</span> {c.subject}
										<span className="faint text-sm"> · {c.author}</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</>
			) : (
				<p className="faint" style={{ marginTop: "var(--sp-3)" }}>
					Lade Git-Zustand …
				</p>
			)}
		</div>
	)
}
