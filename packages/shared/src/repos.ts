/**
 * GitHub-Anbindung (M10): Repositories, Task-Pinning, Diffs und Push.
 *
 * Ablauf einer Task mit gepinntem Repo:
 *
 *   1. Repo verbinden  → einmaliger Klon nach `<dataDir>/repos/<slug>`
 *   2. Task pinnen     → eigener **Worktree** unter `<workspace>/<task-slug>`
 *                        auf einem eigenen Branch `diriz/<task-slug>`
 *   3. Modell arbeitet → schreibt echte Dateien im Worktree
 *   4. Diff ansehen    → `git diff` gegen den Basis-Branch
 *   5. Commit & Push   → Branch pushen, optional Pull-Request öffnen
 *
 * Die Typen liegen hier, weil Core (Ausführung) und Web (Anzeige) exakt
 * dieselbe Sicht auf Änderungen brauchen.
 */

/** Ein verbundenes GitHub-Repository. */
export interface Repo {
	id: string
	owner: string
	name: string
	/** `owner/name` — die übliche Kurzschreibweise. */
	fullName: string
	cloneUrl: string
	defaultBranch: string
	/** Lokaler Klon; `null`, solange noch nicht geklont. */
	localPath: string | null
	lastSyncedAt: string | null
	lastError: string | null
	createdAt: string
}

/** Art der Änderung einer Datei — wie in `git status --porcelain`. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked"

/** Eine geänderte Datei mit Zeilenbilanz. */
export interface FileChange {
	path: string
	/** Bei Umbenennungen der vorherige Pfad. */
	previousPath?: string
	kind: ChangeKind
	additions: number
	deletions: number
	/** true, wenn Git die Datei als binär meldet (kein Text-Diff möglich). */
	binary: boolean
}

/** Der Zustand des Arbeitsverzeichnisses einer Task. */
export interface GitStatus {
	repo: { id: string; fullName: string }
	baseBranch: string
	workBranch: string
	/** Änderungen gegenüber dem Basis-Branch, inklusive noch nicht committeter. */
	files: FileChange[]
	additions: number
	deletions: number
	/** Commits auf dem Arbeitsbranch, die der Basis-Branch nicht hat. */
	commits: GitCommit[]
	/** Noch nicht committete Änderungen im Arbeitsverzeichnis? */
	dirty: boolean
	/** Wurde der Arbeitsbranch schon zum Remote gepusht? */
	pushed: boolean
	prUrl?: string | null
}

export interface GitCommit {
	sha: string
	shortSha: string
	subject: string
	author: string
	date: string
}

/** Ein Diff-Abschnitt (Hunk) mit seinen Zeilen. */
export interface DiffHunk {
	header: string
	lines: DiffLine[]
}

export interface DiffLine {
	kind: "add" | "del" | "context" | "meta"
	text: string
	/** Zeilennummer in der alten bzw. neuen Datei (für die Anzeige). */
	oldLine?: number
	newLine?: number
}

/** Der vollständige Diff einer Datei. */
export interface FileDiff {
	path: string
	previousPath?: string
	kind: ChangeKind
	binary: boolean
	additions: number
	deletions: number
	hunks: DiffHunk[]
	/** Gesetzt, wenn der Diff aus Größengründen gekürzt wurde. */
	truncated?: boolean
}

export interface CommitResult {
	sha: string
	shortSha: string
	subject: string
	filesChanged: number
}

export interface PushResult {
	branch: string
	/** Direkt auf den Basis-Branch gepusht? */
	toBase: boolean
	remoteUrl: string
	pushedAt: string
	/** Fertiger Link zum Öffnen eines Pull-Requests auf GitHub. */
	compareUrl?: string
}

/** Status der GitHub-Verbindung — der Token selbst verlässt nie den Core. */
export interface GitHubConnection {
	connected: boolean
	login?: string
	name?: string
	scopes?: string[]
	/** Fehlermeldung des letzten Verbindungsversuchs. */
	error?: string
}

/** Ein Repository, wie GitHub es für die Auswahl meldet. */
export interface GitHubRepoSummary {
	fullName: string
	owner: string
	name: string
	cloneUrl: string
	defaultBranch: string
	private: boolean
	description?: string
	updatedAt?: string
	/** Bereits in DiriZ verbunden? */
	connected?: boolean
}

/**
 * Zerlegt `owner/name`, eine HTTPS- oder eine SSH-URL in ihre Bestandteile.
 * Gibt `undefined` zurück, wenn nichts Brauchbares erkennbar ist.
 */
export function parseRepoRef(input: string): { owner: string; name: string } | undefined {
	const trimmed = (input ?? "").trim().replace(/\.git$/, "")
	if (trimmed.length === 0) {
		return undefined
	}
	// git@github.com:owner/name
	const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/([^/]+)$/)
	if (ssh?.[1] && ssh[2]) {
		return { owner: ssh[1], name: ssh[2] }
	}
	// https://github.com/owner/name (mit beliebigem Zusatzpfad)
	const https = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/?#]+)/)
	if (https?.[1] && https[2]) {
		return { owner: https[1], name: https[2] }
	}
	// owner/name
	const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/)
	if (short?.[1] && short[2]) {
		return { owner: short[1], name: short[2] }
	}
	return undefined
}

/** Branch-Name aus einem Task-Slug — Git erlaubt nicht jedes Zeichen. */
export function workBranchName(slug: string): string {
	const clean = (slug || "task")
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/^[-./]+|[-./]+$/g, "")
		.slice(0, 60)
	return `diriz/${clean || "task"}`
}
