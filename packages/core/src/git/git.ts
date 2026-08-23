/**
 * Dünne Hülle um das `git`-Kommando (`01-plan.md` §9 — Erweiterung M10).
 *
 * Bewusst das echte Git statt einer JS-Implementierung: Es kann Worktrees,
 * Merges, Umbenennungserkennung und Authentifizierung korrekt — und es ist
 * genau das, womit die Nutzerin ihr Repository ohnehin bedient.
 *
 * **Token-Umgang:** Zugangsdaten werden ausschließlich über
 * `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` in die Umgebung gereicht. Sie stehen
 * damit nie in der Kommandozeile (also nicht in `ps`), nie in der `.git/config`
 * auf der Platte und nie in einer Log-Zeile — `redactToken` putzt zusätzlich
 * jede Ausgabe, bevor sie irgendwo landet.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Voreinstellung: Git darf nie interaktiv nach Zugangsdaten fragen. */
const NON_INTERACTIVE: NodeJS.ProcessEnv = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "echo",
	GCM_INTERACTIVE: "never",
	// Reproduzierbare, sprachunabhängige Ausgaben — sonst bricht das Parsen.
	LC_ALL: "C",
}

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: string[],
		readonly exitCode?: number,
	) {
		super(message)
		this.name = "GitError"
	}
}

export interface GitOptions {
	/** Arbeitsverzeichnis (`-C`). */
	cwd?: string
	/** Zugangs-Token für HTTPS-Remotes; landet nur in der Umgebung. */
	token?: string
	/** Abbruch nach dieser Zeit (Default 2 min — Klone dürfen dauern). */
	timeoutMs?: number
	/** Erwartete Fehler nicht werfen, sondern zurückgeben. */
	allowFailure?: boolean
}

export interface GitResult {
	stdout: string
	stderr: string
	code: number
}

/** Entfernt Tokens aus Texten, die geloggt oder angezeigt werden. */
export function redactToken(text: string, token?: string): string {
	let out = text
	if (token && token.length > 0) {
		out = out.split(token).join("***")
	}
	// Auch Zugangsdaten in URLs (`https://user:pass@host`) unkenntlich machen.
	return out.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1***@")
}

/**
 * Baut die Umgebung für einen Git-Aufruf. Der Token wird als
 * `http.extraheader` gesetzt — über Umgebungsvariablen, damit er weder in der
 * Prozessliste noch in einer Konfigurationsdatei auftaucht.
 */
function buildEnv(token?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...NON_INTERACTIVE }
	if (!token) {
		return env
	}
	const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
	env.GIT_CONFIG_COUNT = "1"
	env.GIT_CONFIG_KEY_0 = "http.extraheader"
	env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
	return env
}

/** Führt ein Git-Kommando aus. Wirft bei Fehlern eine bereinigte `GitError`. */
export async function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
	const full = opts.cwd ? ["-C", opts.cwd, ...args] : args
	try {
		const { stdout, stderr } = await exec("git", full, {
			env: buildEnv(opts.token),
			timeout: opts.timeoutMs ?? 120_000,
			maxBuffer: 32 * 1024 * 1024,
			windowsHide: true,
		})
		return { stdout, stderr, code: 0 }
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; code?: number; message?: string }
		const result: GitResult = {
			stdout: err.stdout ?? "",
			stderr: redactToken(err.stderr ?? err.message ?? "", opts.token),
			code: typeof err.code === "number" ? err.code : 1,
		}
		if (opts.allowFailure) {
			return result
		}
		throw new GitError(
			`git ${redactToken(args.join(" "), opts.token)} fehlgeschlagen: ${firstLine(result.stderr)}`,
			args,
			result.code,
		)
	}
}

function firstLine(text: string): string {
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0)
	return line ?? "unbekannter Fehler"
}

/** `git` im Pfad? Wird beim Verbinden eines Repos geprüft. */
export async function gitAvailable(): Promise<boolean> {
	try {
		await exec("git", ["--version"], { timeout: 5_000, windowsHide: true })
		return true
	} catch {
		return false
	}
}
