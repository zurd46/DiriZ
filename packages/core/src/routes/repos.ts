/**
 * GitHub-Routen (M10): Verbindung, Repositories, Task-Pinning, Diff, Commit,
 * Push und Pull-Request.
 *
 * Der Personal Access Token liegt AES-256-GCM-verschlüsselt in `settings` und
 * verlässt den Core nie — die Oberfläche erfährt nur, ob eine Verbindung steht
 * und zu welchem Konto sie gehört.
 */

import fs from "node:fs"
import path from "node:path"
import {
	type GitHubConnection,
	type GitStatus,
	parseRepoRef,
	type Repo,
	type Task,
	workBranchName,
} from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import type { AppContext } from "../app.js"
import {
	createRepo,
	deleteRepo,
	findRepoByFullName,
	getRepo,
	getSetting,
	getTask,
	listRepos,
	setSetting,
	setTaskRepo,
	updateRepo,
} from "../db/repositories.js"
import { taskWorktreePath } from "../execution/worktree.js"
import { gitAvailable } from "../git/git.js"
import * as github from "../git/github.js"
import {
	changedFiles,
	cloneRepo,
	commitAll,
	commitsAhead,
	defaultBranchOf,
	diffAgainstBase as diffFor,
	ensureWorktree,
	fetchRepo,
	isDirty,
	isPushed,
	isWorktree,
	push as pushBranch,
	rebaseOnBase,
	repoDirName,
} from "../git/repo.js"
import { decryptString, encryptString } from "../security/keys.js"

/** Der entschlüsselte Token — `undefined`, wenn keiner hinterlegt ist. */
export function githubToken(ctx: AppContext): string | undefined {
	const enc = getSetting<string>(ctx.db, "github_token")
	if (!enc) {
		return undefined
	}
	try {
		return decryptString(enc, ctx.secret)
	} catch {
		return undefined
	}
}

export function registerRepos(app: FastifyInstance, ctx: AppContext): void {
	/* ------------------------------- Verbindung ------------------------------- */

	app.get("/api/github", async () => {
		const token = githubToken(ctx)
		if (!token) {
			return { connected: false } satisfies GitHubConnection
		}
		return github.checkConnection(token)
	})

	app.put<{ Body: { token?: string } }>("/api/github", async (req, reply) => {
		const token = req.body?.token?.trim()
		if (!token) {
			return reply.code(400).send({ error: "token ist erforderlich" })
		}
		// Erst prüfen, dann speichern — ein ungültiger Token soll gar nicht erst liegen bleiben.
		const connection = await github.checkConnection(token)
		if (!connection.connected) {
			return reply.code(400).send({ error: connection.error ?? "Token nicht gültig" })
		}
		setSetting(ctx.db, "github_token", encryptString(token, ctx.secret))
		return connection
	})

	app.delete("/api/github", () => {
		setSetting(ctx.db, "github_token", null)
		return { connected: false } satisfies GitHubConnection
	})

	/** Auswahl-Liste: Repositories des Kontos, verbundene sind markiert. */
	app.get("/api/github/repos", async (_req, reply) => {
		const token = githubToken(ctx)
		if (!token) {
			return reply.code(400).send({ error: "Kein GitHub-Token hinterlegt" })
		}
		try {
			const remote = await github.listRepos(token)
			const connected = new Set(listRepos(ctx.db).map((r) => r.fullName))
			return remote.map((r) => ({ ...r, connected: connected.has(r.fullName) }))
		} catch (e) {
			return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
		}
	})

	/* ------------------------------ Repositories ------------------------------ */

	app.get("/api/repos", () => listRepos(ctx.db))

	app.post<{ Body: { repo?: string; cloneUrl?: string; defaultBranch?: string } }>(
		"/api/repos",
		async (req, reply) => {
			const ref = parseRepoRef(req.body?.repo ?? req.body?.cloneUrl ?? "")
			if (!ref) {
				return reply.code(400).send({ error: "repo muss \u201eowner/name\u201c oder eine GitHub-URL sein" })
			}
			if (!(await gitAvailable())) {
				return reply.code(500).send({ error: "git ist auf diesem Rechner nicht installiert" })
			}
			if (findRepoByFullName(ctx.db, ref.owner, ref.name)) {
				return reply.code(409).send({ error: `${ref.owner}/${ref.name} ist bereits verbunden` })
			}

			const token = githubToken(ctx)
			let cloneUrl = req.body?.cloneUrl ?? `https://github.com/${ref.owner}/${ref.name}.git`
			let defaultBranch = req.body?.defaultBranch ?? "main"
			if (token) {
				// Mit Token: Existenz, Zugriff und Standard-Branch vorab klären.
				try {
					const meta = await github.getRepo(token, ref.owner, ref.name)
					cloneUrl = meta.cloneUrl
					defaultBranch = meta.defaultBranch
				} catch (e) {
					return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) })
				}
			}

			const repo = createRepo(ctx.db, { owner: ref.owner, name: ref.name, cloneUrl, defaultBranch })
			// Klonen im Hintergrund: Große Repositories dürfen die Antwort nicht blockieren.
			void syncRepo(ctx, repo.id).catch(() => {
				/* Fehler landet in repos.last_error */
			})
			return reply.code(201).send(repo)
		},
	)

	app.post<{ Params: { id: string } }>("/api/repos/:id/sync", async (req, reply) => {
		const repo = getRepo(ctx.db, req.params.id)
		if (!repo) {
			return reply.code(404).send({ error: "Repository nicht gefunden" })
		}
		const result = await syncRepo(ctx, repo.id)
		if (result.error) {
			return reply.code(502).send({ error: result.error })
		}
		return getRepo(ctx.db, repo.id)
	})

	app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>("/api/repos/:id", (req, reply) => {
		const repo = getRepo(ctx.db, req.params.id)
		if (!repo) {
			return reply.code(404).send({ error: "Repository nicht gefunden" })
		}
		// Nur auf ausdrücklichen Wunsch auch den lokalen Klon löschen.
		if (req.query.purge === "1" && repo.localPath && fs.existsSync(repo.localPath)) {
			fs.rmSync(repo.localPath, { recursive: true, force: true })
		}
		deleteRepo(ctx.db, req.params.id)
		return reply.code(204).send()
	})

	/* ------------------------- Git-Aktionen je Task --------------------------- */

	/** Gemeinsame Vorprüfung: Task, Repo, Worktree — sonst passende Fehlermeldung. */
	type Resolved =
		| { ok: true; task: Task; repo: Repo; baseBranch: string; branch: string; worktree: string }
		| { ok: false; code: number; message: string }

	async function resolveTask(taskId: string, create: boolean): Promise<Resolved> {
		const task = getTask(ctx.db, taskId)
		if (!task) {
			return { ok: false, code: 404, message: "Task nicht gefunden" }
		}
		if (!task.repoId) {
			return { ok: false, code: 400, message: "Task ist an kein Repository gepinnt" }
		}
		const repo = getRepo(ctx.db, task.repoId)
		if (!repo?.localPath) {
			return { ok: false, code: 409, message: "Repository ist noch nicht geklont" }
		}
		const baseBranch = task.baseBranch ?? repo.defaultBranch
		const branch = task.workBranch ?? workBranchName(task.title || task.id)
		const worktree = taskWorktreePath(ctx.workspaceDir, task)

		if (!isWorktree(worktree)) {
			if (!create) {
				return { ok: false, code: 409, message: "Arbeitsbereich der Task existiert noch nicht" }
			}
			await ensureWorktree({
				localPath: repo.localPath,
				worktreePath: worktree,
				branch,
				baseBranch,
				token: githubToken(ctx),
			})
			setTaskRepo(ctx.db, task.id, { workBranch: branch, baseBranch })
		}
		return { ok: true, task, repo, baseBranch, branch, worktree }
	}

	/** Repo an eine Task pinnen — legt zugleich den Arbeitsbereich an. */
	app.put<{ Params: { id: string }; Body: { repoId?: string | null; baseBranch?: string } }>(
		"/api/tasks/:id/repo",
		async (req, reply) => {
			const task = getTask(ctx.db, req.params.id)
			if (!task) {
				return reply.code(404).send({ error: "Task nicht gefunden" })
			}
			const repoId = req.body?.repoId ?? null
			if (repoId === null) {
				setTaskRepo(ctx.db, task.id, { repoId: null, baseBranch: null, workBranch: null })
				return { ...getTask(ctx.db, task.id) }
			}
			const repo = getRepo(ctx.db, repoId)
			if (!repo) {
				return reply.code(404).send({ error: "Repository nicht gefunden" })
			}
			if (!repo.localPath) {
				return reply.code(409).send({ error: "Repository wird noch geklont — kurz warten" })
			}
			const baseBranch = req.body?.baseBranch?.trim() || repo.defaultBranch
			const branch = workBranchName(task.title || task.id)
			try {
				await ensureWorktree({
					localPath: repo.localPath,
					worktreePath: taskWorktreePath(ctx.workspaceDir, task),
					branch,
					baseBranch,
					token: githubToken(ctx),
				})
			} catch (e) {
				return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
			}
			setTaskRepo(ctx.db, task.id, { repoId, baseBranch, workBranch: branch, pushedAt: null, prUrl: null })
			return { ...getTask(ctx.db, task.id) }
		},
	)

	/** Zustand des Arbeitsbereichs: geänderte Dateien, Commits, Push-Stand. */
	app.get<{ Params: { id: string } }>("/api/tasks/:id/git", async (req, reply) => {
		const resolved = await resolveTask(req.params.id, false)
		if (!resolved.ok) {
			return reply.code(resolved.code).send({ error: resolved.message })
		}
		const { task, repo, baseBranch, branch, worktree } = resolved
		const files = await changedFiles(worktree, baseBranch)
		const status: GitStatus = {
			repo: { id: repo.id, fullName: repo.fullName },
			baseBranch,
			workBranch: branch,
			files,
			additions: files.reduce((sum, f) => sum + f.additions, 0),
			deletions: files.reduce((sum, f) => sum + f.deletions, 0),
			commits: await commitsAhead(worktree, baseBranch),
			dirty: await isDirty(worktree),
			pushed: await isPushed(worktree, branch),
			prUrl: task.prUrl ?? null,
		}
		return status
	})

	/** Vollständiger Diff gegen den Basis-Branch (optional eine Datei). */
	app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
		"/api/tasks/:id/git/diff",
		async (req, reply) => {
			const resolved = await resolveTask(req.params.id, false)
			if (!resolved.ok) {
				return reply.code(resolved.code).send({ error: resolved.message })
			}
			const diffs = await diffFor(resolved.worktree, resolved.baseBranch, req.query.path)
			return { baseBranch: resolved.baseBranch, workBranch: resolved.branch, files: diffs }
		},
	)

	app.post<{ Params: { id: string }; Body: { message?: string } }>(
		"/api/tasks/:id/git/commit",
		async (req, reply) => {
			const resolved = await resolveTask(req.params.id, false)
			if (!resolved.ok) {
				return reply.code(resolved.code).send({ error: resolved.message })
			}
			const message = req.body?.message?.trim() || `DiriZ: ${resolved.task.title}`
			try {
				const result = await commitAll({ worktreePath: resolved.worktree, message })
				if (!result) {
					return reply.code(409).send({ error: "Keine Änderungen zum Committen" })
				}
				return result
			} catch (e) {
				return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
			}
		},
	)

	app.post<{
		Params: { id: string }
		Body: { toBase?: boolean; force?: boolean; message?: string; commit?: boolean }
	}>("/api/tasks/:id/git/push", async (req, reply) => {
		const resolved = await resolveTask(req.params.id, false)
		if (!resolved.ok) {
			return reply.code(resolved.code).send({ error: resolved.message })
		}
		const { task, repo, baseBranch, branch, worktree } = resolved
		const token = githubToken(ctx)
		// Nur HTTPS-Remotes brauchen einen Token; SSH und lokale Remotes nicht.
		if (!token && repo.cloneUrl.startsWith("http")) {
			return reply.code(400).send({ error: "Kein GitHub-Token hinterlegt — Pushen nicht möglich" })
		}
		try {
			// Bequemlichkeit: offene Änderungen auf Wunsch gleich mit committen.
			if (req.body?.commit !== false && (await isDirty(worktree))) {
				await commitAll({
					worktreePath: worktree,
					message: req.body?.message?.trim() || `DiriZ: ${task.title}`,
				})
			}
			const toBase = req.body?.toBase === true
			const result = await pushBranch({
				worktreePath: worktree,
				branch,
				targetBranch: toBase ? baseBranch : undefined,
				token,
				force: req.body?.force === true,
			})
			const pushedAt = new Date().toISOString()
			setTaskRepo(ctx.db, task.id, { pushedAt })
			ctx.bus.emit({ event: "task.pushed", data: { taskId: task.id, branch: result.branch, toBase } })
			return {
				branch: result.branch,
				toBase,
				remoteUrl: `https://github.com/${repo.fullName}`,
				pushedAt,
				compareUrl: toBase ? undefined : github.compareUrl(repo.owner, repo.name, baseBranch, branch),
			}
		} catch (e) {
			return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
		}
	})

	app.post<{ Params: { id: string }; Body: { title?: string; body?: string; draft?: boolean } }>(
		"/api/tasks/:id/git/pull-request",
		async (req, reply) => {
			const resolved = await resolveTask(req.params.id, false)
			if (!resolved.ok) {
				return reply.code(resolved.code).send({ error: resolved.message })
			}
			const token = githubToken(ctx)
			if (!token) {
				return reply.code(400).send({ error: "Kein GitHub-Token hinterlegt" })
			}
			const { task, repo, baseBranch, branch, worktree } = resolved
			if (!(await isPushed(worktree, branch))) {
				return reply.code(409).send({ error: "Branch ist noch nicht gepusht" })
			}
			try {
				const pr = await github.createPullRequest(token, {
					owner: repo.owner,
					name: repo.name,
					title: req.body?.title?.trim() || task.title,
					body: req.body?.body ?? pullRequestBody(task.prompt),
					head: branch,
					base: baseBranch,
					draft: req.body?.draft,
				})
				setTaskRepo(ctx.db, task.id, { prUrl: pr.url })
				return pr
			} catch (e) {
				return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
			}
		},
	)

	/** Arbeitsbranch auf den neuesten Stand des Basis-Branches heben. */
	app.post<{ Params: { id: string } }>("/api/tasks/:id/git/rebase", async (req, reply) => {
		const resolved = await resolveTask(req.params.id, false)
		if (!resolved.ok) {
			return reply.code(resolved.code).send({ error: resolved.message })
		}
		const result = await rebaseOnBase(resolved.worktree, resolved.baseBranch, githubToken(ctx))
		if (!result.ok) {
			return reply.code(409).send({ error: `Rebase nicht möglich: ${result.detail}` })
		}
		return { ok: true, baseBranch: resolved.baseBranch }
	})
}

/** Standardtext eines Pull-Requests — der Auftrag, der zur Änderung führte. */
function pullRequestBody(prompt: string): string {
	const excerpt = prompt.length > 1500 ? `${prompt.slice(0, 1500)}\n…` : prompt
	return ["Erstellt von **DiriZ**.", "", "## Auftrag", "", excerpt].join("\n")
}

/**
 * Laufende Synchronisierungen je Repository.
 *
 * Nach dem Verbinden klont DiriZ im Hintergrund. Drückt jemand in derselben
 * Sekunde „Synchronisieren", liefen zwei `git clone` in dasselbe Verzeichnis —
 * der zweite scheiterte. Wer währenddessen fragt, bekommt jetzt dasselbe
 * Ergebnis wie der erste Aufruf.
 */
const runningSyncs = new Map<string, Promise<{ error?: string }>>()

export function syncRepo(ctx: AppContext, repoId: string): Promise<{ error?: string }> {
	const running = runningSyncs.get(repoId)
	if (running) {
		return running
	}
	const task = doSyncRepo(ctx, repoId).finally(() => runningSyncs.delete(repoId))
	runningSyncs.set(repoId, task)
	return task
}

/**
 * Klont bzw. aktualisiert den lokalen Klon eines Repositories und schreibt das
 * Ergebnis zurück (auch den Fehler — die Oberfläche zeigt ihn an).
 */
async function doSyncRepo(ctx: AppContext, repoId: string): Promise<{ error?: string }> {
	const repo = getRepo(ctx.db, repoId)
	if (!repo) {
		return { error: "Repository nicht gefunden" }
	}
	const token = githubToken(ctx)
	const target = repo.localPath ?? path.join(ctx.reposDir, repoDirName(repo.owner, repo.name))
	try {
		await cloneRepo({ cloneUrl: repo.cloneUrl, targetDir: target, token })
		await fetchRepo(target, token)
		const branch = await defaultBranchOf(target, token)
		updateRepo(ctx.db, repoId, {
			localPath: target,
			defaultBranch: branch,
			lastSyncedAt: new Date().toISOString(),
			lastError: null,
		})
		return {}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e)
		updateRepo(ctx.db, repoId, { lastError: message })
		return { error: message }
	}
}
