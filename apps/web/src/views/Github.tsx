/**
 * GitHub-Ansicht (M10): Konto verbinden und Repositories anbinden.
 *
 * Der Personal Access Token wird verschlüsselt im Core abgelegt und kommt nie
 * wieder heraus — die Oberfläche sieht nur, ob eine Verbindung besteht und zu
 * welchem Konto sie gehört. Ein verbundenes Repository wird lokal geklont;
 * jede Task, die daran gepinnt ist, arbeitet in einem eigenen Worktree.
 */

import type { GitHubConnection, GitHubRepoSummary, Repo } from "@diriz/shared"
import { useCallback, useEffect, useState } from "react"
import {
	IconCheckCircle,
	IconGitBranch,
	IconInfo,
	IconKey,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconTrash,
} from "../components/icons.js"
import { api } from "../lib/api.js"
import { useStore } from "../store.js"

export default function Github() {
	const notify = useStore((s) => s.notify)
	const setLastError = useStore((s) => s.setLastError)
	const lastError = useStore((s) => s.lastError)

	const [connection, setConnection] = useState<GitHubConnection | null>(null)
	const [token, setToken] = useState("")
	const [repos, setRepos] = useState<Repo[]>([])
	const [available, setAvailable] = useState<GitHubRepoSummary[] | null>(null)
	const [filter, setFilter] = useState("")
	const [manual, setManual] = useState("")
	const [busy, setBusy] = useState<string | undefined>()

	const fail = useCallback(
		(e: unknown) => setLastError(e instanceof Error ? e.message : String(e)),
		[setLastError],
	)

	const loadRepos = useCallback(async () => {
		try {
			setRepos(await api.get<Repo[]>("/api/repos"))
		} catch (e) {
			fail(e)
		}
	}, [fail])

	useEffect(() => {
		api
			.get<GitHubConnection>("/api/github")
			.then(setConnection)
			.catch(() => setConnection({ connected: false }))
		void loadRepos()
	}, [loadRepos])

	// Solange ein Klon läuft, hat das Repository noch keinen lokalen Pfad —
	// dann in Ruhe nachfragen, statt die Nutzerin raten zu lassen.
	useEffect(() => {
		if (!repos.some((r) => !r.localPath && !r.lastError)) {
			return
		}
		const timer = setInterval(() => void loadRepos(), 2500)
		return () => clearInterval(timer)
	}, [repos, loadRepos])

	const run = async (label: string, fn: () => Promise<void>) => {
		setBusy(label)
		try {
			await fn()
		} catch (e) {
			fail(e)
		} finally {
			setBusy(undefined)
		}
	}

	const connect = () =>
		run("connect", async () => {
			const result = await api.put<GitHubConnection>("/api/github", { token: token.trim() })
			setConnection(result)
			setToken("")
			notify("success", `Verbunden als ${result.login}`)
		})

	const disconnect = () =>
		run("disconnect", async () => {
			await api.del("/api/github")
			setConnection({ connected: false })
			setAvailable(null)
			notify("info", "GitHub-Verbindung entfernt")
		})

	const loadAvailable = () =>
		run("available", async () => {
			setAvailable(await api.get<GitHubRepoSummary[]>("/api/github/repos"))
		})

	const addRepo = (ref: string) =>
		run(`add-${ref}`, async () => {
			await api.post("/api/repos", { repo: ref })
			notify("success", `${ref} verbunden — wird geklont …`)
			setManual("")
			await loadRepos()
		})

	const syncRepo = (repo: Repo) =>
		run(`sync-${repo.id}`, async () => {
			await api.post(`/api/repos/${repo.id}/sync`, {})
			notify("success", `${repo.fullName} aktualisiert`)
			await loadRepos()
		})

	const removeRepo = (repo: Repo) =>
		run(`del-${repo.id}`, async () => {
			const purge = window.confirm(
				`${repo.fullName} entfernen.\n\nOK = auch den lokalen Klon löschen\nAbbrechen = Klon behalten`,
			)
			await api.del(`/api/repos/${repo.id}${purge ? "?purge=1" : ""}`)
			notify("info", `${repo.fullName} entfernt`)
			await loadRepos()
		})

	const connectedNames = new Set(repos.map((r) => r.fullName))
	const shown = (available ?? []).filter(
		(r) =>
			!connectedNames.has(r.fullName) &&
			(filter.trim().length === 0 || r.fullName.toLowerCase().includes(filter.trim().toLowerCase())),
	)

	return (
		<div>
			<div className="page-head">
				<div>
					<h1>GitHub</h1>
					<p className="page-sub">
						Repositories anbinden, an Tasks pinnen und Änderungen direkt pushen. Jede Task arbeitet in einem
						eigenen Branch — der Diff steht in der Task-Ansicht.
					</p>
				</div>
			</div>

			{lastError && <div className="error-banner">{lastError}</div>}

			{/* ------------------------------- Verbindung ------------------------------- */}
			<div className="card">
				<div className="card-head">
					<div className="card-title">
						<IconKey size={16} />
						Konto
					</div>
					{connection?.connected && (
						<span className="badge ok row tight">
							<IconCheckCircle size={13} />
							{connection.login}
						</span>
					)}
				</div>

				{connection === null ? (
					<div className="skeleton" />
				) : connection.connected ? (
					<>
						<p className="card-sub">
							Verbunden als <strong>{connection.name || connection.login}</strong>
							{connection.scopes && connection.scopes.length > 0 && (
								<> · Berechtigungen: {connection.scopes.join(", ")}</>
							)}
						</p>
						<div className="row" style={{ marginTop: "var(--sp-3)" }}>
							<button
								type="button"
								className="btn"
								onClick={() => void loadAvailable()}
								disabled={busy !== undefined}
							>
								<IconRefresh size={15} />
								{busy === "available" ? "…" : "Meine Repositories laden"}
							</button>
							<button
								type="button"
								className="btn danger"
								onClick={() => void disconnect()}
								disabled={busy !== undefined}
							>
								Verbindung trennen
							</button>
						</div>
					</>
				) : (
					<>
						<p className="card-sub">
							Ein Personal Access Token mit der Berechtigung <span className="mono">repo</span> genügt. Er
							wird verschlüsselt gespeichert und nie wieder ausgegeben.
						</p>
						<div className="row" style={{ marginTop: "var(--sp-3)", flexWrap: "wrap" }}>
							<label className="field" style={{ flex: 1, minWidth: 280 }}>
								Personal Access Token
								<input
									type="password"
									value={token}
									onChange={(e) => setToken(e.target.value)}
									placeholder="ghp_… oder github_pat_…"
									autoComplete="off"
								/>
							</label>
							<button
								type="button"
								className="btn primary"
								style={{ alignSelf: "flex-end" }}
								onClick={() => void connect()}
								disabled={busy !== undefined || token.trim().length === 0}
							>
								{busy === "connect" ? "Prüfe …" : "Verbinden"}
							</button>
						</div>
						{connection.error && (
							<p className="hint" style={{ marginTop: "var(--sp-2)" }}>
								<IconInfo size={14} />
								<span>{connection.error}</span>
							</p>
						)}
					</>
				)}
			</div>

			{/* ---------------------------- Verbundene Repos ---------------------------- */}
			<div className="card">
				<div className="card-head">
					<div className="card-title">
						<IconGitBranch size={16} />
						Verbundene Repositories
					</div>
					<span className="badge subtle">{repos.length}</span>
				</div>

				{repos.length === 0 ? (
					<p className="faint">Noch keine — unten hinzufügen.</p>
				) : (
					<div className="table-wrap">
						<table className="table">
							<thead>
								<tr>
									<th>Repository</th>
									<th>Branch</th>
									<th>Zustand</th>
									<th className="actions-cell" />
								</tr>
							</thead>
							<tbody>
								{repos.map((repo) => (
									<tr key={repo.id}>
										<td>
											<div className="cell-title">{repo.fullName}</div>
											<div className="cell-meta mono">{repo.cloneUrl}</div>
										</td>
										<td className="mono">{repo.defaultBranch}</td>
										<td>
											{repo.lastError ? (
												<span className="badge err" title={repo.lastError}>
													Fehler
												</span>
											) : repo.localPath ? (
												<span className="badge ok">geklont</span>
											) : (
												<span className="badge warn">klont …</span>
											)}
										</td>
										<td className="actions-cell">
											<button
												type="button"
												className="icon-btn sm"
												aria-label={`${repo.fullName} synchronisieren`}
												title="Vom Remote aktualisieren"
												onClick={() => void syncRepo(repo)}
												disabled={busy !== undefined}
											>
												<IconRefresh size={15} />
											</button>
											<button
												type="button"
												className="icon-btn sm danger"
												aria-label={`${repo.fullName} entfernen`}
												onClick={() => void removeRepo(repo)}
												disabled={busy !== undefined}
											>
												<IconTrash size={15} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{repos.some((r) => r.lastError) && (
					<p className="hint" style={{ marginTop: "var(--sp-3)" }}>
						<IconInfo size={14} />
						<span>{repos.find((r) => r.lastError)?.lastError}</span>
					</p>
				)}
			</div>

			{/* ------------------------------- Hinzufügen ------------------------------- */}
			<div className="card">
				<div className="card-head">
					<div className="card-title">
						<IconPlus size={16} />
						Repository hinzufügen
					</div>
				</div>

				<div className="row" style={{ flexWrap: "wrap" }}>
					<label className="field" style={{ flex: 1, minWidth: 280 }}>
						owner/name oder GitHub-URL
						<input
							value={manual}
							onChange={(e) => setManual(e.target.value)}
							placeholder="zurd46/DiriZ"
							onKeyDown={(e) => {
								if (e.key === "Enter" && manual.trim()) {
									void addRepo(manual.trim())
								}
							}}
						/>
					</label>
					<button
						type="button"
						className="btn primary"
						style={{ alignSelf: "flex-end" }}
						onClick={() => void addRepo(manual.trim())}
						disabled={busy !== undefined || manual.trim().length === 0}
					>
						Hinzufügen
					</button>
				</div>

				{available !== null && (
					<div style={{ marginTop: "var(--sp-4)" }}>
						<div className="row tight" style={{ marginBottom: "var(--sp-2)" }}>
							<IconSearch size={15} />
							<input
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Repositories filtern …"
								aria-label="Repositories filtern"
								style={{ maxWidth: 320 }}
							/>
							<span className="faint text-sm">{shown.length} verfügbar</span>
						</div>
						<div className="repo-picker">
							{shown.slice(0, 60).map((repo) => (
								<button
									key={repo.fullName}
									type="button"
									className="repo-option"
									onClick={() => void addRepo(repo.fullName)}
									disabled={busy !== undefined}
								>
									<span className="repo-option-name">
										{repo.fullName}
										{repo.private && <span className="badge subtle">privat</span>}
									</span>
									{repo.description && <span className="repo-option-desc">{repo.description}</span>}
								</button>
							))}
							{shown.length === 0 && <p className="faint">Alle passenden Repositories sind verbunden.</p>}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
