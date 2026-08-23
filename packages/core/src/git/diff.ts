/**
 * Parser für Unified Diffs (`git diff --patch`).
 *
 * Die Oberfläche zeigt Änderungen zeilenweise mit alter und neuer
 * Zeilennummer — dafür muss der Patch strukturiert vorliegen. Bewusst hier im
 * Core geparst und nicht im Browser: So sehen API-Antwort, Tests und Anzeige
 * dieselbe Struktur, und ein sehr großer Patch belastet die Oberfläche nicht.
 */

import type { ChangeKind, DiffHunk, DiffLine, FileDiff } from "@diriz/shared"

/** Obergrenze pro Datei — schützt Browser und Speicher vor Riesen-Diffs. */
const MAX_LINES_PER_FILE = 2000

/** `a/pfad` → `pfad`; behandelt auch Pfade mit Leerzeichen und `/dev/null`. */
function stripPrefix(p: string): string {
	if (p === "/dev/null") {
		return ""
	}
	return p.replace(/^"?[ab]\//, "").replace(/"$/, "")
}

/** Zerlegt die `diff --git`-Zeile in alten und neuen Pfad. */
function parseHeaderPaths(line: string): { old: string; new: string } | undefined {
	// Ohne Anführungszeichen: `diff --git a/alt b/neu`
	const plain = line.match(/^diff --git (\S+) (\S+)$/)
	if (plain?.[1] && plain[2]) {
		return { old: stripPrefix(plain[1]), new: stripPrefix(plain[2]) }
	}
	// Mit Anführungszeichen (Sonderzeichen im Pfad): `diff --git "a/x y" "b/x y"`
	const quoted = line.match(/^diff --git (".*?"|\S+) (".*?"|\S+)$/)
	if (quoted?.[1] && quoted[2]) {
		return { old: stripPrefix(quoted[1]), new: stripPrefix(quoted[2]) }
	}
	return undefined
}

/** `@@ -12,7 +12,9 @@ context` → Startzeilen für beide Seiten. */
function parseHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const m = line.match(/^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
	if (!m?.[1] || !m[2]) {
		return undefined
	}
	return { oldLine: Number(m[1]), newLine: Number(m[2]) }
}

/**
 * Wandelt die Ausgabe von `git diff --patch` in strukturierte Datei-Diffs.
 * Unbekannte Metazeilen (`index …`, `mode …`) werden verworfen — sie tragen
 * für die Anzeige nichts bei.
 */
export function parseUnifiedDiff(patch: string): FileDiff[] {
	const files: FileDiff[] = []
	const lines = (patch ?? "").split("\n")

	let current: FileDiff | undefined
	let hunk: DiffHunk | undefined
	let oldLine = 0
	let newLine = 0
	let lineBudget = MAX_LINES_PER_FILE

	const closeFile = () => {
		if (current) {
			files.push(current)
		}
		current = undefined
		hunk = undefined
	}

	for (const raw of lines) {
		if (raw.startsWith("diff --git ")) {
			closeFile()
			const paths = parseHeaderPaths(raw)
			current = {
				path: paths?.new || paths?.old || "?",
				kind: "modified",
				binary: false,
				additions: 0,
				deletions: 0,
				hunks: [],
			}
			lineBudget = MAX_LINES_PER_FILE
			continue
		}
		if (!current) {
			continue
		}

		if (raw.startsWith("new file mode")) {
			current.kind = "added"
			continue
		}
		if (raw.startsWith("deleted file mode")) {
			current.kind = "deleted"
			continue
		}
		if (raw.startsWith("rename from ")) {
			current.kind = "renamed"
			current.previousPath = raw.slice("rename from ".length).trim()
			continue
		}
		if (raw.startsWith("rename to ")) {
			current.path = raw.slice("rename to ".length).trim()
			continue
		}
		if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
			current.binary = true
			continue
		}
		if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
			// Pfadangaben stehen schon in der `diff --git`-Zeile; nur `/dev/null`
			// verrät zusätzlich Anlegen bzw. Löschen.
			if (raw === "--- /dev/null") {
				current.kind = "added"
			} else if (raw === "+++ /dev/null") {
				current.kind = "deleted"
			}
			continue
		}

		if (raw.startsWith("@@")) {
			const pos = parseHunkHeader(raw)
			if (!pos) {
				continue
			}
			oldLine = pos.oldLine
			newLine = pos.newLine
			hunk = { header: raw, lines: [] }
			current.hunks.push(hunk)
			continue
		}

		if (!hunk) {
			continue
		}
		if (lineBudget <= 0) {
			current.truncated = true
			continue
		}

		if (raw.startsWith("+")) {
			current.additions++
			hunk.lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ })
			lineBudget--
		} else if (raw.startsWith("-")) {
			current.deletions++
			hunk.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ })
			lineBudget--
		} else if (raw.startsWith("\\")) {
			// „\ No newline at end of file" — als Hinweis behalten.
			hunk.lines.push({ kind: "meta", text: raw.slice(2) })
		} else if (raw.startsWith(" ") || raw.length === 0) {
			hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ })
			lineBudget--
		}
	}
	closeFile()
	return files
}

/** `git diff --numstat -z`-Ausgabe → Zeilenbilanz je Pfad. */
export function parseNumstat(
	output: string,
): { path: string; previousPath?: string; additions: number; deletions: number; binary: boolean }[] {
	const result: {
		path: string
		previousPath?: string
		additions: number
		deletions: number
		binary: boolean
	}[] = []
	for (const line of output.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) {
			continue
		}
		const parts = trimmed.split("\t")
		if (parts.length < 3) {
			continue
		}
		const [addRaw, delRaw, ...rest] = parts
		// Umbenennung: `alt => neu` oder `pfad/{alt => neu}/datei`
		const pathPart = rest.join("\t")
		const binary = addRaw === "-" || delRaw === "-"
		const renamed = pathPart.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
		let path = pathPart
		let previousPath: string | undefined
		if (renamed) {
			const [, prefix = "", from = "", to = "", suffix = ""] = renamed
			previousPath = `${prefix}${from}${suffix}`.replace(/\/\//g, "/")
			path = `${prefix}${to}${suffix}`.replace(/\/\//g, "/")
		} else if (pathPart.includes(" => ")) {
			const [from, to] = pathPart.split(" => ")
			previousPath = from
			path = to ?? pathPart
		}
		result.push({
			path,
			previousPath,
			additions: binary ? 0 : Number(addRaw) || 0,
			deletions: binary ? 0 : Number(delRaw) || 0,
			binary,
		})
	}
	return result
}

/** Kürzel aus `git status --porcelain` → verständliche Änderungsart. */
export function statusCodeToKind(code: string): ChangeKind {
	const c = code.trim()
	if (c === "??") {
		return "untracked"
	}
	if (c.includes("R")) {
		return "renamed"
	}
	if (c.includes("D")) {
		return "deleted"
	}
	if (c.includes("A")) {
		return "added"
	}
	return "modified"
}

/** Nur zum Testen exportiert: Zeilenbudget pro Datei. */
export const DIFF_LINE_BUDGET = MAX_LINES_PER_FILE

/** Hilfsfunktion für die Anzeige: sind überhaupt Zeilen im Diff? */
export function hasVisibleChanges(diff: FileDiff): boolean {
	return diff.hunks.some((h: DiffHunk) => h.lines.some((l: DiffLine) => l.kind === "add" || l.kind === "del"))
}
