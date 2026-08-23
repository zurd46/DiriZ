/**
 * M10-Tests der Git-Schicht — gegen **echte** Repositories.
 *
 * Statt Git wegzumocken wird ein bare Repository im Temp-Verzeichnis angelegt
 * und als Remote benutzt. Damit prüfen die Tests genau das, was im Betrieb
 * passiert: klonen, Worktree je Task, Diff gegen den Basis-Branch, committen
 * und pushen — nur ohne Netzwerk und ohne GitHub-Konto.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseNumstat, parseUnifiedDiff, statusCodeToKind } from "../src/git/diff.js"
import { gitAvailable, redactToken } from "../src/git/git.js"
import {
	changedFiles,
	cloneRepo,
	commitAll,
	commitsAhead,
	defaultBranchOf,
	diffAgainstBase,
	ensureWorktree,
	isDirty,
	isPushed,
	push,
	removeWorktree,
	repoDirName,
} from "../src/git/repo.js"

let root: string
let remote: string
let clone: string
let worktree: string

/** Kurzform für Git-Aufrufe im Test-Setup. */
function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
	})
}

beforeAll(async () => {
	expect(await gitAvailable(), "git muss im Pfad liegen").toBe(true)

	root = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-git-"))
	remote = path.join(root, "remote.git")
	fs.mkdirSync(remote)
	sh(remote, "init", "--bare", "--initial-branch=main", ".")

	// Das Remote mit einem ersten Commit füllen (wie ein echtes Repository).
	const seed = path.join(root, "seed")
	fs.mkdirSync(seed)
	sh(seed, "init", "--initial-branch=main", ".")
	fs.writeFileSync(path.join(seed, "README.md"), "# Projekt\n\nZeile eins.\n")
	fs.mkdirSync(path.join(seed, "src"))
	fs.writeFileSync(path.join(seed, "src", "app.ts"), "export const version = 1\n")
	sh(seed, "add", "-A")
	sh(seed, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "Erster Commit")
	sh(seed, "remote", "add", "origin", remote)
	sh(seed, "push", "-u", "origin", "main")

	clone = path.join(root, "clone")
	worktree = path.join(root, "worktrees", "task-eins")
})

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true })
})

describe("Klonen und Worktrees", () => {
	it("klont ein Repository und erkennt den Standard-Branch", async () => {
		await cloneRepo({ cloneUrl: remote, targetDir: clone })
		expect(fs.existsSync(path.join(clone, ".git"))).toBe(true)
		expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toContain("# Projekt")
		expect(await defaultBranchOf(clone)).toBe("main")
	})

	it("klont nicht erneut, wenn der Klon schon existiert", async () => {
		fs.writeFileSync(path.join(clone, "marker.txt"), "bleibt")
		await cloneRepo({ cloneUrl: remote, targetDir: clone })
		expect(fs.existsSync(path.join(clone, "marker.txt"))).toBe(true)
		fs.rmSync(path.join(clone, "marker.txt"))
	})

	it("legt je Task einen eigenen Worktree auf eigenem Branch an", async () => {
		await ensureWorktree({
			localPath: clone,
			worktreePath: worktree,
			branch: "diriz/task-eins",
			baseBranch: "main",
		})
		expect(fs.existsSync(path.join(worktree, "README.md"))).toBe(true)
		expect(sh(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("diriz/task-eins")

		// Ein zweiter Aufruf ist folgenlos — die Task arbeitet weiter im selben Baum.
		fs.writeFileSync(path.join(worktree, "zwischenstand.txt"), "nicht verlieren")
		await ensureWorktree({
			localPath: clone,
			worktreePath: worktree,
			branch: "diriz/task-eins",
			baseBranch: "main",
		})
		expect(fs.existsSync(path.join(worktree, "zwischenstand.txt"))).toBe(true)
		fs.rmSync(path.join(worktree, "zwischenstand.txt"))
	})

	it("erlaubt zwei Tasks gleichzeitig am selben Repo", async () => {
		const zweiter = path.join(root, "worktrees", "task-zwei")
		await ensureWorktree({
			localPath: clone,
			worktreePath: zweiter,
			branch: "diriz/task-zwei",
			baseBranch: "main",
		})
		expect(sh(zweiter, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("diriz/task-zwei")
		await removeWorktree(clone, zweiter)
		expect(fs.existsSync(path.join(zweiter, ".git"))).toBe(false)
	})
})

describe("Änderungen erkennen", () => {
	it("führt neue, geänderte und gelöschte Dateien auf", async () => {
		fs.writeFileSync(path.join(worktree, "README.md"), "# Projekt\n\nZeile eins geändert.\n")
		fs.writeFileSync(path.join(worktree, "NEU.md"), "Ganz neu.\n")
		fs.rmSync(path.join(worktree, "src", "app.ts"))

		const files = await changedFiles(worktree, "main")
		const byPath = new Map(files.map((f) => [f.path, f]))

		expect(byPath.get("README.md")?.kind).toBe("modified")
		expect(byPath.get("README.md")?.additions).toBe(1)
		expect(byPath.get("README.md")?.deletions).toBe(1)
		expect(byPath.get("NEU.md")?.kind).toBe("added")
		expect(byPath.get("src/app.ts")?.kind).toBe("deleted")
		expect(await isDirty(worktree)).toBe(true)
	})

	it("liefert einen strukturierten Diff mit Zeilennummern", async () => {
		const diffs = await diffAgainstBase(worktree, "main")
		const readme = diffs.find((d) => d.path === "README.md")
		expect(readme).toBeDefined()
		expect(readme?.additions).toBe(1)
		expect(readme?.hunks.length).toBeGreaterThan(0)

		const lines = readme?.hunks[0]?.lines ?? []
		const added = lines.find((l) => l.kind === "add")
		expect(added?.text).toBe("Zeile eins geändert.")
		expect(added?.newLine).toBeGreaterThan(0)
		expect(lines.some((l) => l.kind === "del")).toBe(true)

		// Auf eine Datei einschränken.
		const nurNeu = await diffAgainstBase(worktree, "main", "NEU.md")
		expect(nurNeu).toHaveLength(1)
		expect(nurNeu[0]?.kind).toBe("added")
	})
})

describe("Committen und Pushen", () => {
	it("committet alle Änderungen und zählt die Dateien", async () => {
		const result = await commitAll({ worktreePath: worktree, message: "Task: README angepasst" })
		expect(result).toBeDefined()
		expect(result?.subject).toBe("Task: README angepasst")
		expect(result?.filesChanged).toBe(3)
		expect(result?.shortSha.length).toBeGreaterThanOrEqual(7)
		expect(await isDirty(worktree)).toBe(false)

		const ahead = await commitsAhead(worktree, "main")
		expect(ahead).toHaveLength(1)
		expect(ahead[0]?.subject).toBe("Task: README angepasst")
		expect(ahead[0]?.author).toBe("DiriZ")
	})

	it("meldet, wenn es nichts zu committen gibt", async () => {
		expect(await commitAll({ worktreePath: worktree, message: "leer" })).toBeUndefined()
	})

	it("pusht den Arbeitsbranch zum Remote", async () => {
		expect(await isPushed(worktree, "diriz/task-eins")).toBe(false)
		const result = await push({ worktreePath: worktree, branch: "diriz/task-eins" })
		expect(result.branch).toBe("diriz/task-eins")
		expect(await isPushed(worktree, "diriz/task-eins")).toBe(true)

		// Der Branch liegt jetzt wirklich im Remote.
		expect(sh(remote, "branch", "--list", "diriz/task-eins")).toContain("diriz/task-eins")
	})

	it("pusht auf Wunsch direkt auf den Basis-Branch", async () => {
		fs.writeFileSync(path.join(worktree, "DIREKT.md"), "direkt auf main\n")
		await commitAll({ worktreePath: worktree, message: "Direkt auf main" })
		await push({ worktreePath: worktree, branch: "diriz/task-eins", targetBranch: "main" })

		const mainLog = sh(remote, "log", "--format=%s", "-1", "main").trim()
		expect(mainLog).toBe("Direkt auf main")
	})

	it("die Änderungen sind gegenüber der neuen Basis leer", async () => {
		const files = await changedFiles(worktree, "main")
		expect(files).toHaveLength(0)
	})
})

describe("Sicherheit und Hilfsfunktionen", () => {
	it("entfernt Tokens aus Ausgaben", () => {
		expect(redactToken("Fehler bei ghp_supergeheim123", "ghp_supergeheim123")).toBe("Fehler bei ***")
		expect(redactToken("https://user:pass@github.com/o/r.git")).toBe("https://***@github.com/o/r.git")
	})

	it("bildet gültige Verzeichnisnamen aus owner/name", () => {
		expect(repoDirName("zurd46", "DiriZ")).toBe("zurd46-DiriZ")
		expect(repoDirName("mein/owner", "re po")).toBe("mein-owner-re-po")
	})
})

describe("Diff-Parser", () => {
	it("erkennt Anlegen, Löschen, Umbenennen und Binärdateien", () => {
		const patch = [
			"diff --git a/neu.txt b/neu.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/neu.txt",
			"@@ -0,0 +1,2 @@",
			"+erste",
			"+zweite",
			"diff --git a/weg.txt b/weg.txt",
			"deleted file mode 100644",
			"--- a/weg.txt",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-war da",
			"diff --git a/alt.txt b/neu-name.txt",
			"similarity index 100%",
			"rename from alt.txt",
			"rename to neu-name.txt",
			"diff --git a/bild.png b/bild.png",
			"Binary files a/bild.png and b/bild.png differ",
		].join("\n")

		const files = parseUnifiedDiff(patch)
		expect(files.map((f) => f.path)).toEqual(["neu.txt", "weg.txt", "neu-name.txt", "bild.png"])
		expect(files[0]?.kind).toBe("added")
		expect(files[0]?.additions).toBe(2)
		expect(files[1]?.kind).toBe("deleted")
		expect(files[1]?.deletions).toBe(1)
		expect(files[2]?.kind).toBe("renamed")
		expect(files[2]?.previousPath).toBe("alt.txt")
		expect(files[3]?.binary).toBe(true)
	})

	it("zählt Zeilennummern für beide Seiten mit", () => {
		const patch = [
			"diff --git a/a.txt b/a.txt",
			"--- a/a.txt",
			"+++ b/a.txt",
			"@@ -10,3 +10,4 @@ kontext",
			" gleich",
			"-alt",
			"+neu",
			"+extra",
			" ende",
		].join("\n")
		const lines = parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? []
		expect(lines[0]).toMatchObject({ kind: "context", oldLine: 10, newLine: 10 })
		expect(lines[1]).toMatchObject({ kind: "del", oldLine: 11, text: "alt" })
		expect(lines[2]).toMatchObject({ kind: "add", newLine: 11, text: "neu" })
		expect(lines[3]).toMatchObject({ kind: "add", newLine: 12, text: "extra" })
		expect(lines[4]).toMatchObject({ kind: "context", oldLine: 12, newLine: 13 })
	})

	it("liest numstat inklusive Umbenennungen und Binärdateien", () => {
		const out = ["3\t1\tsrc/app.ts", "-\t-\tbild.png", "2\t0\tsrc/{alt => neu}/datei.ts"].join("\n")
		const stats = parseNumstat(out)
		expect(stats[0]).toMatchObject({ path: "src/app.ts", additions: 3, deletions: 1, binary: false })
		expect(stats[1]).toMatchObject({ path: "bild.png", binary: true, additions: 0 })
		expect(stats[2]).toMatchObject({ path: "src/neu/datei.ts", previousPath: "src/alt/datei.ts" })
	})

	it("übersetzt die Status-Kürzel", () => {
		expect(statusCodeToKind("??")).toBe("untracked")
		expect(statusCodeToKind("A")).toBe("added")
		expect(statusCodeToKind("D")).toBe("deleted")
		expect(statusCodeToKind("R100")).toBe("renamed")
		expect(statusCodeToKind("M")).toBe("modified")
	})
})
