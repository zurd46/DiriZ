/**
 * M10-Routentests: Repository verbinden, an eine Task pinnen, Änderungen als
 * Diff lesen, committen und pushen.
 *
 * Als Remote dient ein lokales bare Repository — dadurch läuft der komplette
 * Weg bis zum Push durch, ohne GitHub-Konto und ohne Netzwerk. Die reinen
 * GitHub-API-Teile (Token prüfen, PR öffnen) sind bewusst nicht dabei: Sie
 * bräuchten ein echtes Konto und werden über Fehlerpfade abgesichert.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FileDiff, GitStatus, Repo, Task } from "@diriz/shared"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createTask, getTask } from "../src/db/repositories.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { taskWorktreePath } from "../src/execution/worktree.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"

let db: Db
let app: FastifyInstance
let root: string
let remote: string
let workspaceDir: string
let repo: Repo
let task: Task
let engine: ExecutionEngine

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
	})
}

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-repos-test-"))
	workspaceDir = path.join(root, "workspace")
	fs.mkdirSync(workspaceDir)

	// Remote mit einem ersten Commit — steht für „das Projekt auf GitHub".
	remote = path.join(root, "remote.git")
	fs.mkdirSync(remote)
	sh(remote, "init", "--bare", "--initial-branch=main", ".")
	const seed = path.join(root, "seed")
	fs.mkdirSync(seed)
	sh(seed, "init", "--initial-branch=main", ".")
	fs.writeFileSync(path.join(seed, "README.md"), "# Demo\n\nStand vorher.\n")
	sh(seed, "add", "-A")
	sh(seed, "-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "Start")
	sh(seed, "remote", "add", "origin", remote)
	sh(seed, "push", "-u", "origin", "main")

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-repos-data-"))
	db = openDatabase(dataDir)
	migrate(db)
	const bus = new EventBus()
	const feedback = new Feedback()
	const log = () => {}
	const registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		() => undefined,
	)
	engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
	const ctx: AppContext = {
		db,
		bus,
		registry,
		engine,
		feedback,
		secret: Buffer.from("test-secret-0123456789abcdef0123456789abcdef"),
		workspaceDir,
		reposDir: path.join(root, "repos"),
	}
	app = await buildApp(ctx)
})

afterAll(async () => {
	await app.close().catch(() => {})
	db.close()
	fs.rmSync(root, { recursive: true, force: true })
})

describe("Repository verbinden", () => {
	it("weist unbrauchbare Angaben ab", async () => {
		const res = await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "kein-repo" } })
		expect(res.statusCode).toBe(400)
		expect((res.json() as { error: string }).error).toContain("owner/name")
	})

	it("legt das Repository an und klont es beim Synchronisieren", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/repos",
			payload: { repo: "demo/projekt", cloneUrl: remote },
		})
		expect(res.statusCode).toBe(201)
		repo = res.json() as Repo
		expect(repo.fullName).toBe("demo/projekt")

		const sync = await app.inject({ method: "POST", url: `/api/repos/${repo.id}/sync` })
		expect(sync.statusCode).toBe(200)
		repo = sync.json() as Repo
		expect(repo.localPath).toBeTruthy()
		expect(repo.defaultBranch).toBe("main")
		expect(repo.lastError).toBeNull()
		expect(fs.existsSync(path.join(repo.localPath ?? "", "README.md"))).toBe(true)
	})

	it("verhindert doppeltes Verbinden desselben Repositories", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/repos",
			payload: { repo: "demo/projekt", cloneUrl: remote },
		})
		expect(res.statusCode).toBe(409)
	})
})

describe("Task an ein Repository pinnen", () => {
	it("meldet Git-Anfragen ohne Pin sauber ab", async () => {
		const ohne = createTask(db, { prompt: "ohne Repo", title: "Ohne Repo" })
		const res = await app.inject({ method: "GET", url: `/api/tasks/${ohne.id}/git` })
		expect(res.statusCode).toBe(400)
		expect((res.json() as { error: string }).error).toContain("gepinnt")
	})

	it("legt beim Pinnen den Arbeitsbereich als Worktree an", async () => {
		task = createTask(db, { prompt: "README ergänzen", title: "Readme Ausbau" })
		const res = await app.inject({
			method: "PUT",
			url: `/api/tasks/${task.id}/repo`,
			payload: { repoId: repo.id },
		})
		expect(res.statusCode).toBe(200)
		const updated = res.json() as Task
		expect(updated.repoId).toBe(repo.id)
		expect(updated.baseBranch).toBe("main")
		// Der Branch trägt die Kurz-ID der Task — sonst kollidieren zwei Tasks
		// mit ähnlichem Titel im selben Repository.
		expect(updated.workBranch).toMatch(/^diriz\/readme-ausbau-[0-9a-f]{8}$/)

		const dir = taskWorktreePath(workspaceDir, updated)
		expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true)
		expect(sh(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toMatch(/^diriz\/readme-ausbau-[0-9a-f]{8}$/)
	})

	it("löst die Bindung wieder", async () => {
		const andere = createTask(db, { prompt: "x", title: "Lösbar" })
		await app.inject({ method: "PUT", url: `/api/tasks/${andere.id}/repo`, payload: { repoId: repo.id } })
		const res = await app.inject({
			method: "PUT",
			url: `/api/tasks/${andere.id}/repo`,
			payload: { repoId: null },
		})
		expect(res.statusCode).toBe(200)
		expect(getTask(db, andere.id)?.repoId).toBeNull()
	})
})

describe("Änderungen, Diff, Commit und Push", () => {
	/** Wie das Modell arbeiten würde: Dateien im Arbeitsbereich verändern. */
	function edit(): string {
		const dir = taskWorktreePath(workspaceDir, getTask(db, task.id) as Task)
		fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n\nStand nachher.\n")
		fs.writeFileSync(path.join(dir, "NOTIZEN.md"), "Vom Modell erzeugt.\n")
		return dir
	}

	it("listet geänderte Dateien mit Zeilenbilanz", async () => {
		edit()
		const res = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/git` })
		expect(res.statusCode).toBe(200)
		const status = res.json() as GitStatus
		expect(status.repo.fullName).toBe("demo/projekt")
		expect(status.baseBranch).toBe("main")
		expect(status.dirty).toBe(true)
		expect(status.pushed).toBe(false)
		expect(status.additions).toBeGreaterThan(0)

		const byPath = new Map(status.files.map((f) => [f.path, f]))
		expect(byPath.get("README.md")?.kind).toBe("modified")
		expect(byPath.get("NOTIZEN.md")?.kind).toBe("added")
	})

	it("liefert den Diff mit Zeilennummern", async () => {
		const res = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/git/diff` })
		expect(res.statusCode).toBe(200)
		const body = res.json() as { files: FileDiff[] }
		const readme = body.files.find((f) => f.path === "README.md")
		expect(readme?.hunks[0]?.lines.some((l) => l.kind === "add" && l.text === "Stand nachher.")).toBe(true)

		// Auf eine Datei eingeschränkt.
		const einzeln = await app.inject({
			method: "GET",
			url: `/api/tasks/${task.id}/git/diff?path=NOTIZEN.md`,
		})
		const nur = (einzeln.json() as { files: FileDiff[] }).files
		expect(nur).toHaveLength(1)
		expect(nur[0]?.kind).toBe("added")
	})

	it("committet die Änderungen", async () => {
		const res = await app.inject({
			method: "POST",
			url: `/api/tasks/${task.id}/git/commit`,
			payload: { message: "Readme ausgebaut" },
		})
		expect(res.statusCode).toBe(200)
		const commit = res.json() as { subject: string; filesChanged: number }
		expect(commit.subject).toBe("Readme ausgebaut")
		expect(commit.filesChanged).toBe(2)

		const status = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/git` })).json() as GitStatus
		expect(status.dirty).toBe(false)
		expect(status.commits).toHaveLength(1)
		// Die Dateien bleiben im Diff gegen den Basis-Branch sichtbar.
		expect(status.files).toHaveLength(2)
	})

	it("meldet einen leeren Commit-Versuch statt still zu tun", async () => {
		const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/git/commit`, payload: {} })
		expect(res.statusCode).toBe(409)
	})

	it("pusht den Arbeitsbranch zum Remote", async () => {
		const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/git/push`, payload: {} })
		expect(res.statusCode).toBe(200)
		const push = res.json() as { branch: string; toBase: boolean; pushedAt: string; compareUrl?: string }
		expect(push.branch).toMatch(/^diriz\/readme-ausbau-[0-9a-f]{8}$/)
		expect(push.toBase).toBe(false)
		expect(push.compareUrl).toContain("compare/main...diriz/readme-ausbau-")

		expect(sh(remote, "branch", "--list", "diriz/readme-ausbau-*")).toContain("diriz/readme-ausbau-")
		expect(getTask(db, task.id)?.pushedAt).toBe(push.pushedAt)

		const status = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/git` })).json() as GitStatus
		expect(status.pushed).toBe(true)
	})

	it("pusht auf Wunsch direkt auf den Basis-Branch", async () => {
		const dir = taskWorktreePath(workspaceDir, getTask(db, task.id) as Task)
		fs.writeFileSync(path.join(dir, "DIREKT.md"), "sofort auf main\n")

		// Ohne eigenen Commit: der Push committet die offenen Änderungen mit.
		const res = await app.inject({
			method: "POST",
			url: `/api/tasks/${task.id}/git/push`,
			payload: { toBase: true, message: "Direkt auf main" },
		})
		expect(res.statusCode).toBe(200)
		expect((res.json() as { toBase: boolean }).toBase).toBe(true)
		expect(sh(remote, "log", "--format=%s", "-1", "main").trim()).toBe("Direkt auf main")
	})

	it("verlangt für einen Pull-Request einen Token", async () => {
		const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/git/pull-request` })
		expect(res.statusCode).toBe(400)
		expect((res.json() as { error: string }).error).toContain("Token")
	})
})

/**
 * Nach einem erfolgreichen Lauf sichert die Engine die Arbeit selbst: Commit auf
 * den Arbeitsbranch. Ohne das bliebe alles als uncommitteter Stand im Worktree
 * liegen und wäre beim nächsten Lauf nicht mehr von neuem zu unterscheiden.
 */
describe("Automatisches Sichern", () => {
	it("committet auf den Arbeitsbranch — nie auf den Basis-Branch", async () => {
		const eigene = createTask(db, { prompt: "SKU korrigieren", title: "SKU Fix" })
		const pin = await app.inject({
			method: "PUT",
			url: `/api/tasks/${eigene.id}/repo`,
			payload: { repoId: repo.id },
		})
		expect(pin.statusCode).toBe(200)
		const gepinnt = getTask(db, eigene.id) as Task
		const dir = taskWorktreePath(workspaceDir, gepinnt)
		fs.writeFileSync(path.join(dir, "AUTOCOMMIT.md"), "# vom Modell geschrieben\n")
		// Bewusst die private Methode: Sie trägt die Zusicherung „die Arbeit geht
		// nicht verloren“, und ein voller Modelllauf gehört nicht in diesen Test.
		await (engine as unknown as { autoCommit: (t: Task) => Promise<void> }).autoCommit(gepinnt)

		expect(sh(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toMatch(/^diriz\//)
		expect(sh(dir, "log", "-1", "--format=%s").trim()).toContain("SKU Fix")
		// Nichts bleibt liegen …
		expect(sh(dir, "status", "--porcelain").trim()).toBe("")
		// … und der Basis-Branch bleibt unberührt.
		expect(sh(dir, "log", "origin/main", "--oneline")).not.toContain("SKU Fix")
	})
})

describe("GitHub-Verbindung", () => {
	it("meldet ohne Token, dass keine Verbindung besteht", async () => {
		const res = await app.inject({ method: "GET", url: "/api/github" })
		expect(res.statusCode).toBe(200)
		expect((res.json() as { connected: boolean }).connected).toBe(false)
	})

	it("weist einen leeren Token ab", async () => {
		const res = await app.inject({ method: "PUT", url: "/api/github", payload: { token: "  " } })
		expect(res.statusCode).toBe(400)
	})

	it("verlangt für die Repo-Auswahl einen Token", async () => {
		const res = await app.inject({ method: "GET", url: "/api/github/repos" })
		expect(res.statusCode).toBe(400)
	})
})

describe("Repository entfernen", () => {
	it("löst die Bindung der Tasks und löscht auf Wunsch den Klon", async () => {
		const localPath = repo.localPath ?? ""
		const res = await app.inject({ method: "DELETE", url: `/api/repos/${repo.id}?purge=1` })
		expect(res.statusCode).toBe(204)
		expect(getTask(db, task.id)?.repoId).toBeNull()
		expect(fs.existsSync(localPath)).toBe(false)
	})
})
