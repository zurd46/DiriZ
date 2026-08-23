/**
 * Repository-Operationen für die GitHub-Anbindung (M10).
 *
 * Ein Repo wird **einmal** geklont (`<dataDir>/repos/<owner>-<name>`). Jede
 * Task bekommt daraus einen eigenen **Worktree** im Workspace, auf einem
 * eigenen Branch. Das hat drei Vorteile:
 *
 *  - Die Datei-Werkzeuge des Modells arbeiten unverändert im echten Repo.
 *  - Mehrere Tasks können parallel an verschiedenen Ständen arbeiten, teilen
 *    sich aber einen Objektspeicher (kein wiederholtes Klonen).
 *  - `git diff` gegen den Basis-Branch zeigt exakt die Änderung dieser Task.
 */

import fs from "node:fs"
import path from "node:path"
import type { ChangeKind, FileChange, FileDiff, GitCommit } from "@diriz/shared"
import { parseNumstat, parseUnifiedDiff, statusCodeToKind } from "./diff.js"
import { git, redactToken } from "./git.js"

/** Autor der von DiriZ erzeugten Commits (überschreibbar per Environment). */
const AUTHOR_NAME = process.env.DIRIZ_GIT_NAME ?? "DiriZ"
const AUTHOR_EMAIL = process.env.DIRIZ_GIT_EMAIL ?? "diriz@localhost"

/** Identität als `-c`-Argumente — verändert die Repo-Konfiguration nicht. */
const IDENTITY = [
	"-c",
	`user.name=${AUTHOR_NAME}`,
	"-c",
	`user.email=${AUTHOR_EMAIL}`,
	// Commits sollen nie an einer fehlenden GPG-Konfiguration scheitern.
	"-c",
	"commit.gpgsign=false",
]

/** Verzeichnisname für den lokalen Klon eines Repos. */
export function repoDirName(owner: string, name: string): string {
	return `${owner}-${name}`.replace(/[^A-Za-z0-9._-]/g, "-")
}

/* --------------------------------- Klonen ----------------------------------- */

export interface CloneOptions {
	cloneUrl: string
	targetDir: string
	token?: string
}

/** Klont ein Repository (voller Klon, damit Worktrees und Diffs funktionieren). */
export async function cloneRepo(opts: CloneOptions): Promise<void> {
	fs.mkdirSync(path.dirname(opts.targetDir), { recursive: true })
	if (fs.existsSync(path.join(opts.targetDir, ".git"))) {
		return
	}
	await git(["clone", "--quiet", opts.cloneUrl, opts.targetDir], { token: opts.token, timeoutMs: 600_000 })
}

/** Holt den aktuellen Stand vom Remote und räumt verschwundene Branches weg. */
export async function fetchRepo(localPath: string, token?: string): Promise<void> {
	await git(["fetch", "--prune", "--quiet", "origin"], { cwd: localPath, token, timeoutMs: 300_000 })
}

/** Ermittelt den Standard-Branch (das, worauf `origin/HEAD` zeigt). */
export async function defaultBranchOf(localPath: string, token?: string): Promise<string> {
	const symbolic = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
		cwd: localPath,
		allowFailure: true,
	})
	const fromRef = symbolic.stdout.trim().replace(/^origin\//, "")
	if (fromRef.length > 0) {
		return fromRef
	}
	// Kein origin/HEAD (kommt bei manchen Klonen vor) — beim Remote nachfragen.
	const remote = await git(["remote", "show", "origin"], { cwd: localPath, token, allowFailure: true })
	const head = remote.stdout.match(/HEAD branch:\s*(\S+)/)?.[1]
	return head && head !== "(unknown)" ? head : "main"
}

/* -------------------------------- Worktrees ---------------------------------- */

export interface WorktreeOptions {
	localPath: string
	worktreePath: string
	branch: string
	baseBranch: string
	token?: string
}

/**
 * Legt den Arbeitsbereich einer Task an (oder verwendet den vorhandenen).
 * Der Branch startet immer auf dem aktuellen Stand von `origin/<base>`.
 */
export async function ensureWorktree(opts: WorktreeOptions): Promise<string> {
	const { localPath, worktreePath, branch, baseBranch, token } = opts
	if (fs.existsSync(path.join(worktreePath, ".git"))) {
		return worktreePath
	}
	await fetchRepo(localPath, token)
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true })

	// Karteileichen aufräumen: ein früher gelöschtes Verzeichnis blockiert sonst
	// den Branch-Namen ("already checked out").
	await git(["worktree", "prune"], { cwd: localPath, allowFailure: true })

	const start = `origin/${baseBranch}`
	const exists = await git(["rev-parse", "--verify", "--quiet", start], {
		cwd: localPath,
		allowFailure: true,
	})
	const startPoint = exists.code === 0 ? start : baseBranch
	await git(["worktree", "add", "-B", branch, worktreePath, startPoint], { cwd: localPath, token })
	return worktreePath
}

/** Entfernt den Worktree einer Task (der Branch bleibt erhalten). */
export async function removeWorktree(localPath: string, worktreePath: string): Promise<void> {
	await git(["worktree", "remove", "--force", worktreePath], { cwd: localPath, allowFailure: true })
	await git(["worktree", "prune"], { cwd: localPath, allowFailure: true })
}

/** Liegt hier ein benutzbares Git-Arbeitsverzeichnis? */
export function isWorktree(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git"))
}

/* ---------------------------------- Status ----------------------------------- */

/**
 * Damit neue, noch nicht hinzugefügte Dateien im Diff auftauchen, werden sie
 * mit „intent to add" vorgemerkt. Das ändert nur den Index, nie den Inhalt —
 * und ist der übliche Weg, Arbeitsstand und Basis vollständig zu vergleichen.
 */
async function markIntentToAdd(worktreePath: string): Promise<void> {
	await git(["add", "--intent-to-add", "--all", "."], { cwd: worktreePath, allowFailure: true })
}

/** Vergleichspunkt: der gemeinsame Vorfahr von Basis-Branch und Arbeitsstand. */
export async function mergeBase(worktreePath: string, baseBranch: string): Promise<string> {
	for (const ref of [`origin/${baseBranch}`, baseBranch]) {
		const res = await git(["merge-base", "HEAD", ref], { cwd: worktreePath, allowFailure: true })
		const sha = res.stdout.trim()
		if (res.code === 0 && sha.length > 0) {
			return sha
		}
	}
	// Kein gemeinsamer Vorfahr (frisches Repo ohne Commits) — leerer Baum.
	const empty = await git(["hash-object", "-t", "tree", "/dev/null"], {
		cwd: worktreePath,
		allowFailure: true,
	})
	return empty.stdout.trim() || "HEAD"
}

/** Änderungen des Arbeitsbereichs gegenüber dem Basis-Branch. */
export async function changedFiles(worktreePath: string, baseBranch: string): Promise<FileChange[]> {
	await markIntentToAdd(worktreePath)
	const base = await mergeBase(worktreePath, baseBranch)

	const numstat = await git(["diff", "--numstat", "--find-renames", base], {
		cwd: worktreePath,
		allowFailure: true,
	})
	const stats = parseNumstat(numstat.stdout)

	// Änderungsart je Pfad aus `--name-status`, ergänzt um unversionierte Dateien.
	const nameStatus = await git(["diff", "--name-status", "--find-renames", base], {
		cwd: worktreePath,
		allowFailure: true,
	})
	const kinds = new Map<string, ChangeKind>()
	for (const line of nameStatus.stdout.split("\n")) {
		const parts = line.trim().split("\t")
		if (parts.length < 2 || !parts[0]) {
			continue
		}
		const target = parts[parts.length - 1]
		if (target) {
			kinds.set(target, statusCodeToKind(parts[0]))
		}
	}

	return stats.map((s) => ({
		path: s.path,
		previousPath: s.previousPath,
		kind: kinds.get(s.path) ?? "modified",
		additions: s.additions,
		deletions: s.deletions,
		binary: s.binary,
	}))
}

/** Gibt es noch nicht committete Änderungen? */
export async function isDirty(worktreePath: string): Promise<boolean> {
	const res = await git(["status", "--porcelain"], { cwd: worktreePath, allowFailure: true })
	return res.stdout.trim().length > 0
}

/** Commits, die der Arbeitsbranch dem Basis-Branch voraushat. */
export async function commitsAhead(worktreePath: string, baseBranch: string): Promise<GitCommit[]> {
	const base = await mergeBase(worktreePath, baseBranch)
	const res = await git(["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", `${base}..HEAD`], {
		cwd: worktreePath,
		allowFailure: true,
	})
	return res.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((line) => {
			const [sha = "", shortSha = "", subject = "", author = "", date = ""] = line.split("\x1f")
			return { sha, shortSha, subject, author, date }
		})
}

/** Wurde der Branch bereits zum Remote gepusht? */
export async function isPushed(worktreePath: string, branch: string): Promise<boolean> {
	const res = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
		cwd: worktreePath,
		allowFailure: true,
	})
	return res.code === 0 && res.stdout.trim().length > 0
}

/* ----------------------------------- Diff ------------------------------------ */

/**
 * Vollständiger Diff gegen den Basis-Branch — optional auf eine Datei
 * eingeschränkt. Enthält auch noch nicht committete Änderungen.
 */
export async function diffAgainstBase(
	worktreePath: string,
	baseBranch: string,
	filePath?: string,
): Promise<FileDiff[]> {
	await markIntentToAdd(worktreePath)
	const base = await mergeBase(worktreePath, baseBranch)
	const args = ["diff", "--patch", "--find-renames", "--no-color", "--unified=3", base]
	if (filePath) {
		args.push("--", filePath)
	}
	const res = await git(args, { cwd: worktreePath, allowFailure: true })
	return parseUnifiedDiff(res.stdout)
}

/* --------------------------------- Schreiben --------------------------------- */

export interface CommitOptions {
	worktreePath: string
	message: string
}

/** Alles vormerken und committen. `undefined`, wenn es nichts zu committen gab. */
export async function commitAll(
	opts: CommitOptions,
): Promise<{ sha: string; shortSha: string; subject: string; filesChanged: number } | undefined> {
	const { worktreePath, message } = opts
	await git(["add", "--all", "."], { cwd: worktreePath })
	const staged = await git(["diff", "--cached", "--name-only"], { cwd: worktreePath, allowFailure: true })
	const files = staged.stdout.split("\n").filter((l) => l.trim().length > 0)
	if (files.length === 0) {
		return undefined
	}
	await git([...IDENTITY, "commit", "--quiet", "-m", message], { cwd: worktreePath })
	const head = await git(["log", "-1", "--format=%H%x1f%h%x1f%s"], { cwd: worktreePath })
	const [sha = "", shortSha = "", subject = ""] = head.stdout.trim().split("\x1f")
	return { sha, shortSha, subject, filesChanged: files.length }
}

export interface PushOptions {
	worktreePath: string
	branch: string
	/** Direkt auf den Basis-Branch statt auf den Arbeitsbranch. */
	targetBranch?: string
	token?: string
	force?: boolean
}

/** Pusht den aktuellen Stand. Ohne `targetBranch` auf den Arbeitsbranch. */
export async function push(opts: PushOptions): Promise<{ branch: string; output: string }> {
	const target = opts.targetBranch ?? opts.branch
	const args = ["push", "--quiet"]
	if (opts.force) {
		// `--force-with-lease` schützt davor, fremde Commits zu überschreiben.
		args.push("--force-with-lease")
	}
	args.push("origin", `HEAD:refs/heads/${target}`)
	const res = await git(args, { cwd: opts.worktreePath, token: opts.token, timeoutMs: 300_000 })
	// Nach dem Push die Remote-Referenz aktualisieren, damit `isPushed` stimmt.
	await git(["fetch", "--quiet", "origin"], { cwd: opts.worktreePath, token: opts.token, allowFailure: true })
	return { branch: target, output: redactToken(res.stderr || res.stdout, opts.token).trim() }
}

/** Holt neue Commits des Basis-Branches in den Arbeitsbranch (Rebase). */
export async function rebaseOnBase(
	worktreePath: string,
	baseBranch: string,
	token?: string,
): Promise<{ ok: boolean; detail?: string }> {
	await git(["fetch", "--quiet", "origin", baseBranch], { cwd: worktreePath, token, allowFailure: true })
	const res = await git([...IDENTITY, "rebase", `origin/${baseBranch}`], {
		cwd: worktreePath,
		allowFailure: true,
	})
	if (res.code === 0) {
		return { ok: true }
	}
	// Bei Konflikt sauber zurückrollen — ein halb rebaseter Worktree wäre eine Falle.
	await git(["rebase", "--abort"], { cwd: worktreePath, allowFailure: true })
	return { ok: false, detail: res.stderr.split("\n")[0] ?? "Rebase fehlgeschlagen" }
}
