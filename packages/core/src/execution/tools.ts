/**
 * Datei-Tools für den Agent-Loop (M8, `01-plan.md` §v1.5):
 * `list_files`, `read_file`, `write_file` — strikt in der Task-Sandbox.
 *
 * Jede Operation wird per `tool.call`-Event + Log emittiert (volle
 * Transparenz). Pfad-Sicherheit: Relativ-Pfad-Validierung + Prefix-Check
 * nach dem Join (doppelte Absicherung, wie bei den File-Blöcken in §9).
 */

import fs from "node:fs"
import path from "node:path"
import type { ToolCallRequest, ToolSpec } from "@diriz/shared"
import { isSafeRelPath } from "./files.js"

/** Max. Größe eines `read_file`-Ergebnisses (100 kB) — schützt den Kontext. */
const MAX_READ_BYTES = 100 * 1024

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: "list_files",
		description: "Listet alle Dateien im Workspace-Verzeichnis (relative Pfade).",
		parameters: { type: "object", properties: {}, required: [] },
	},
	{
		name: "read_file",
		description: "Liest eine Datei aus dem Workspace (relativer Pfad, max. 100 kB).",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Relativer Dateipfad im Workspace" } },
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Schreibt/überschreibt eine Datei im Workspace (relativer Pfad).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relativer Dateipfad im Workspace" },
				content: { type: "string", description: "Vollständiger Dateiinhalt" },
			},
			required: ["path", "content"],
		},
	},
]

export interface ToolOpResult {
	ok: boolean
	detail: string
}

type EmitToolCall = (data: { name: string; argsSummary: string; ok: boolean; detail?: string }) => void
type LogFn = (level: "info" | "warn" | "error", scope: string, msg: string) => void

/** Führt einen Tool-Call in der Sandbox aus — nie werfend (Fehler werden gemeldet). */
export function executeTool(
	baseDir: string,
	call: ToolCallRequest,
	emitOp: EmitToolCall,
	log: LogFn,
): ToolOpResult {
	const args = call.arguments ?? {}
	let result: ToolOpResult

	try {
		switch (call.name) {
			case "list_files": {
				result = { ok: true, detail: listFiles(baseDir).join("\n") || "(leer)" }
				break
			}
			case "read_file": {
				const p = String(args.path ?? "")
				if (!isSafeRelPath(p)) {
					throw new Error(`Ungültiger Pfad: ${p}`)
				}
				const abs = resolveInSandbox(baseDir, p)
				if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
					throw new Error(`Datei nicht gefunden: ${p}`)
				}
				const stat = fs.statSync(abs)
				if (stat.size > MAX_READ_BYTES) {
					throw new Error(
						`Datei zu groß (${Math.round(stat.size / 1024)} kB, max. ${MAX_READ_BYTES / 1024} kB)`,
					)
				}
				result = { ok: true, detail: fs.readFileSync(abs, "utf8") }
				break
			}
			case "write_file": {
				const p = String(args.path ?? "")
				if (!isSafeRelPath(p)) {
					throw new Error(`Ungültiger Pfad: ${p}`)
				}
				const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "")
				const abs = resolveInSandbox(baseDir, p)
				fs.mkdirSync(path.dirname(abs), { recursive: true })
				fs.writeFileSync(abs, content, "utf8")
				result = { ok: true, detail: `Geschrieben: ${p} (${Buffer.byteLength(content)} Bytes)` }
				break
			}
			default:
				throw new Error(`Unbekanntes Tool: ${call.name}`)
		}
	} catch (e) {
		result = { ok: false, detail: e instanceof Error ? e.message : String(e) }
	}

	const argsSummary = summarizeArgs(call)
	emitOp({ name: call.name, argsSummary, ok: result.ok, detail: result.detail.slice(0, 200) })
	log(
		result.ok ? "info" : "warn",
		"agent",
		`${call.name} ${argsSummary} → ${result.ok ? "ok" : result.detail}`,
	)
	return result
}

/** Absoluter Pfad mit Prefix-Check — bleibt garantiert in der Sandbox. */
function resolveInSandbox(baseDir: string, relPath: string): string {
	const abs = path.resolve(baseDir, relPath)
	if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
		throw new Error(`Pfad außerhalb des Workspaces: ${relPath}`)
	}
	return abs
}

function listFiles(dir: string): string[] {
	const out: string[] = []
	const walk = (d: string, prefix: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				walk(path.join(d, entry.name), rel)
			} else {
				out.push(rel)
			}
		}
	}
	try {
		walk(dir, "")
	} catch {
		// leeres/fehlendes Verzeichnis → leer
	}
	return out.sort()
}

/** Kurze Zusammenfassung der Argumente für Event/Log (ohne großen Content). */
function summarizeArgs(call: ToolCallRequest): string {
	const args = call.arguments ?? {}
	if (call.name === "write_file") {
		const len = typeof args.content === "string" ? Buffer.byteLength(args.content) : 0
		return `${args.path ?? "?"} (${len} Bytes)`
	}
	if (call.name === "read_file") {
		return String(args.path ?? "?")
	}
	return "(keine Argumente)"
}
