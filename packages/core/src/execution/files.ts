/**
 * AI-Datei-Blöcke & Workspace-Sandbox (`01-plan.md` §9).
 *
 * Das Modell liefert Dateien als Markdown-Codeblöcke:
 *
 *     ```file:path=src/auth.py
 *     def check(...): ...
 *     ```
 *
 * Der Core parst diese Blöcke und schreibt sie in die Workspace-Sandbox
 * (`<workspace>/<tag>/<task-slug>/…`). Pfad-Traversal ist doppelt
 * abgesichert: Relativ-Pfad-Validierung + Prefix-Check nach dem Join.
 */

import fs from "node:fs"
import path from "node:path"

export interface FileBlock {
	relPath: string
	content: string
}

const FILE_BLOCK_SOURCE = /```file:path=([A-Za-z0-9._\-/ ]+)\n([\s\S]*?)```/

export function parseFileBlocks(text: string): FileBlock[] {
	const blocks: FileBlock[] = []
	const re = new RegExp(FILE_BLOCK_SOURCE.source, "g")
	let match = re.exec(text)
	while (match !== null) {
		const relPath = (match[1] ?? "").trim()
		if (relPath.length > 0) {
			blocks.push({ relPath, content: match[2] ?? "" })
		}
		match = re.exec(text)
	}
	return blocks
}

/** Nur saubere relative Pfade — ohne `..`, ohne absolut, ohne `~`. */
export function isSafeRelPath(p: string): boolean {
	if (p.startsWith("/") || p.startsWith("~") || p.includes("\\")) {
		return false
	}
	const parts = p.split("/")
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..")
}

export interface WrittenFile {
	relPath: string
	size: number
	absPath: string
}

export function writeWorkspaceFiles(
	workspaceDir: string,
	taskSlug: string,
	blocks: FileBlock[],
): WrittenFile[] {
	return writeWorkspaceFilesAt(path.join(workspaceDir, taskSlug), blocks)
}

/**
 * Wie `writeWorkspaceFiles`, aber mit fertigem Zielverzeichnis — nötig, seit
 * eine Task auch in einem Git-Worktree arbeiten kann (M10).
 */
export function writeWorkspaceFilesAt(base: string, blocks: FileBlock[]): WrittenFile[] {
	const written: WrittenFile[] = []
	for (const block of blocks) {
		if (!isSafeRelPath(block.relPath)) {
			continue
		}
		const abs = path.join(base, block.relPath)
		// Verteidigung in der Tiefe: nach dem Join muss der Pfad in der Sandbox bleiben.
		if (!abs.startsWith(base + path.sep) && abs !== base) {
			continue
		}
		fs.mkdirSync(path.dirname(abs), { recursive: true })
		fs.writeFileSync(abs, block.content, "utf8")
		written.push({ relPath: block.relPath, size: Buffer.byteLength(block.content, "utf8"), absPath: abs })
	}
	return written
}
