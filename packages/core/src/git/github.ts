/**
 * GitHub-REST-Client (M10) — nur das, was DiriZ wirklich braucht:
 * Verbindung prüfen, Repositories auflisten, Pull-Requests öffnen.
 *
 * Bewusst ohne SDK (wie bei den LLM-Adaptern): nativer `fetch`, klar
 * abgegrenzte Funktionen. Der Token wird ausschließlich im `Authorization`-
 * Header mitgegeben und niemals in einer Fehlermeldung wiedergegeben.
 */

import type { GitHubConnection, GitHubRepoSummary } from "@diriz/shared"

const API = process.env.DIRIZ_GITHUB_API ?? "https://api.github.com"

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = "GitHubError"
	}
}

interface RequestOptions {
	method?: string
	body?: unknown
	token: string
	timeoutMs?: number
}

async function request<T>(path: string, opts: RequestOptions): Promise<{ data: T; headers: Headers }> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
	try {
		const res = await fetch(`${API}${path}`, {
			method: opts.method ?? "GET",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${opts.token}`,
				"x-github-api-version": "2022-11-28",
				"user-agent": "DiriZ",
				...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal,
		})
		if (!res.ok) {
			throw new GitHubError(await describeError(res), res.status)
		}
		return { data: (await res.json()) as T, headers: res.headers }
	} catch (e) {
		if (e instanceof GitHubError) {
			throw e
		}
		if (e instanceof Error && e.name === "AbortError") {
			throw new GitHubError("GitHub hat nicht rechtzeitig geantwortet", 504)
		}
		throw new GitHubError(e instanceof Error ? e.message : String(e), 0)
	} finally {
		clearTimeout(timer)
	}
}

/** Übersetzt die häufigsten GitHub-Fehler in eine handlungsleitende Meldung. */
async function describeError(res: Response): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] }
	const detail = body.errors
		?.map((e) => e.message)
		.filter(Boolean)
		.join("; ")
	const base = body.message ?? `HTTP ${res.status}`
	if (res.status === 401) {
		return "Token ungültig oder abgelaufen — bitte einen neuen Personal Access Token hinterlegen"
	}
	if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
		return "GitHub-Ratelimit erreicht — später erneut versuchen"
	}
	if (res.status === 403) {
		return `Zugriff verweigert: ${base} (fehlt dem Token die Berechtigung „repo"?)`
	}
	if (res.status === 404) {
		return "Nicht gefunden — existiert das Repository und darf der Token darauf zugreifen?"
	}
	return detail ? `${base}: ${detail}` : base
}

/* -------------------------------- Verbindung --------------------------------- */

interface UserResponse {
	login: string
	name?: string | null
}

/** Prüft den Token und liefert das zugehörige Konto. */
export async function checkConnection(token: string): Promise<GitHubConnection> {
	try {
		const { data, headers } = await request<UserResponse>("/user", { token })
		const scopes = (headers.get("x-oauth-scopes") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
		return { connected: true, login: data.login, name: data.name ?? undefined, scopes }
	} catch (e) {
		return { connected: false, error: e instanceof Error ? e.message : String(e) }
	}
}

/* ------------------------------- Repositories -------------------------------- */

interface RepoResponse {
	full_name: string
	name: string
	owner: { login: string }
	clone_url: string
	default_branch: string
	private: boolean
	description?: string | null
	updated_at?: string
	permissions?: { push?: boolean }
}

function toSummary(r: RepoResponse): GitHubRepoSummary {
	return {
		fullName: r.full_name,
		owner: r.owner.login,
		name: r.name,
		cloneUrl: r.clone_url,
		defaultBranch: r.default_branch,
		private: r.private,
		description: r.description ?? undefined,
		updatedAt: r.updated_at,
	}
}

/**
 * Repositories des angemeldeten Kontos — zuletzt bearbeitete zuerst.
 * `limit` begrenzt die Seitenzahl, damit große Konten die Auswahl nicht sprengen.
 */
export async function listRepos(token: string, limit = 100): Promise<GitHubRepoSummary[]> {
	const perPage = Math.min(100, limit)
	const pages = Math.ceil(limit / perPage)
	const all: GitHubRepoSummary[] = []
	for (let page = 1; page <= pages; page++) {
		const { data } = await request<RepoResponse[]>(
			`/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
			{ token },
		)
		all.push(...data.map(toSummary))
		if (data.length < perPage) {
			break
		}
	}
	return all
}

/** Ein einzelnes Repository — auch als Prüfung, ob der Token darauf darf. */
export async function getRepo(token: string, owner: string, name: string): Promise<GitHubRepoSummary> {
	const { data } = await request<RepoResponse>(`/repos/${owner}/${name}`, { token })
	return toSummary(data)
}

/* ------------------------------ Pull-Requests -------------------------------- */

interface PullResponse {
	html_url: string
	number: number
	state: string
}

export interface PullRequestInput {
	owner: string
	name: string
	title: string
	body?: string
	/** Quellbranch (der Arbeitsbranch der Task). */
	head: string
	/** Zielbranch (der Basis-Branch). */
	base: string
	draft?: boolean
}

/**
 * Öffnet einen Pull-Request. Existiert für denselben Branch schon einer, wird
 * dessen Link zurückgegeben statt eines Fehlers — zweimal „PR öffnen" zu
 * drücken darf nicht bestraft werden.
 */
export async function createPullRequest(
	token: string,
	input: PullRequestInput,
): Promise<{ url: string; number: number; existed: boolean }> {
	try {
		const { data } = await request<PullResponse>(`/repos/${input.owner}/${input.name}/pulls`, {
			token,
			method: "POST",
			body: {
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
				draft: input.draft ?? false,
			},
		})
		return { url: data.html_url, number: data.number, existed: false }
	} catch (e) {
		if (e instanceof GitHubError && e.status === 422) {
			const existing = await findOpenPullRequest(token, input.owner, input.name, input.head)
			if (existing) {
				return { ...existing, existed: true }
			}
		}
		throw e
	}
}

/** Sucht einen offenen PR für den Branch (`owner:branch` ist das Suchformat). */
export async function findOpenPullRequest(
	token: string,
	owner: string,
	name: string,
	head: string,
): Promise<{ url: string; number: number } | undefined> {
	const { data } = await request<PullResponse[]>(
		`/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
		{ token },
	)
	const first = data[0]
	return first ? { url: first.html_url, number: first.number } : undefined
}

/**
 * Link zum Vergleich zweier Branches — der schnellste Weg zu einem PR.
 * Schrägstriche bleiben stehen: `diriz/mein-branch` ist ein gültiger Branch,
 * und GitHub erwartet ihn in der URL unverändert.
 */
export function compareUrl(owner: string, name: string, base: string, head: string): string {
	const ref = (b: string) => b.split("/").map(encodeURIComponent).join("/")
	return `https://github.com/${owner}/${name}/compare/${ref(base)}...${ref(head)}?expand=1`
}
