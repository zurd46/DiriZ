/**
 * Werkzeuge für den Agent-Loop: `list_files`, `read_file`, `write_file` und
 * `run_command` — strikt in der Task-Sandbox.
 *
 * Jede Operation wird per `tool.call`-Event + Log emittiert (volle
 * Transparenz). Pfad-Sicherheit: Relativ-Pfad-Validierung + Prefix-Check
 * nach dem Join (doppelte Absicherung, wie bei den File-Blöcken in §9).
 *
 * ## Warum es `run_command` gibt — und warum es eng geführt ist
 *
 * Ohne Ausführung schreibt ein Modell Prüfskripte und wartet auf ein Ergebnis,
 * das nie kommt. Beobachtet: zehn Varianten von `verify_final.mjs`, dieselbe
 * Datei 51-mal geschrieben, 23 Minuten ohne Fortschritt. Ein Werkzeug, das
 * Code ausführt, ist die ehrliche Antwort darauf.
 *
 * Es ist aber auch das gefährlichste Werkzeug im Haus — es läuft im
 * Arbeitsverzeichnis eines echten Repositories, neben `.env`-Dateien und einem
 * Git-Remote. Deshalb vier Grenzen, die zusammen wirken:
 *
 * 1. **Keine Shell.** Gestartet wird mit Argument-Liste (`shell: false`) —
 *    `;`, `&&`, `|`, `$(…)` und `>` sind damit gewöhnliche Zeichen, keine
 *    Befehle. Die gesamte Klasse der Shell-Injektion fällt weg.
 * 2. **Erlaubnisliste.** Nur bekannte Programme (`node`, `npm`, `python3`, …),
 *    einstellbar. Kein Pfad im Programmnamen — `./mein-skript` geht nicht.
 * 3. **Sandbox.** Arbeitsverzeichnis ist der Task-Ordner; Argumente, die wie
 *    Pfade aussehen, müssen darin bleiben.
 * 4. **Frist und Deckel.** Zeitlimit je Aufruf, Ausgabe gekappt, Abbruch über
 *    dasselbe Signal wie der Rest des Laufs.
 */

import fs from "node:fs"
import path from "node:path"
import type { ToolCallRequest, ToolSpec } from "@diriz/shared"
import { isSafeRelPath } from "./files.js"

/** Max. Größe eines `read_file`-Ergebnisses (100 kB) — schützt den Kontext. */
const MAX_READ_BYTES = 100 * 1024

/** Max. Ausgabe eines Befehls (32 kB) — ein `npm install` flutet sonst den Kontext. */
const MAX_OUTPUT_BYTES = 32 * 1024

/** Frist je Befehl. Länger als ein Testlauf, kürzer als eine Kaffeepause. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/**
 * Programme, die ein Modell starten darf.
 *
 * Bewusst kurz und auf Entwicklungswerkzeuge beschränkt. Was hier fehlt, kann
 * in den Einstellungen ergänzt werden — nicht vom Modell.
 *
 * Nicht enthalten und mit Absicht: alles, was ausserhalb des Arbeitsordners
 * wirkt (`rm`, `mv`, `sudo`, `ssh`, `curl`, `docker`) und jede Shell
 * (`sh`, `bash`, `zsh`) — die würde alle übrigen Grenzen aushebeln.
 */
export const DEFAULT_ALLOWED_COMMANDS = [
	"node",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"python3",
	"pytest",
	"tsc",
	"vitest",
	"jest",
	"eslint",
	"biome",
	"go",
	"cargo",
	"git",
]

/**
 * Git-Unterbefehle, die nur lesen. Alles andere (`push`, `remote`, `config`,
 * `clean`, `reset`) bleibt dem Menschen vorbehalten: Was im Repository landet
 * und was hinausgeht, entscheidet nicht das Modell.
 */
const GIT_READONLY = new Set(["status", "diff", "log", "show", "branch", "ls-files", "blame", "rev-parse"])

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
	{
		name: "run_command",
		description:
			"Führt ein Programm im Workspace aus und liefert dessen Ausgabe (stdout/stderr, gekappt). " +
			"Keine Shell: `command` ist das Programm, `args` sind seine Argumente — Zeichen wie |, &&, ; " +
			"oder $() haben keine Sonderbedeutung. Erlaubt sind Entwicklungswerkzeuge (node, npm, python3, " +
			"pytest, git status/diff/log …). Damit prüfst du deine Arbeit, statt Prüfskripte zu schreiben, " +
			"die niemand ausführt.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Programm, z. B. `node` oder `npm` — ohne Pfad" },
				args: {
					type: "array",
					items: { type: "string" },
					description: 'Argumente, z. B. ["test"] oder ["pruefe.mjs"]',
				},
			},
			required: ["command"],
		},
	},
]

export interface ToolOpResult {
	ok: boolean
	detail: string
}

type EmitToolCall = (data: { name: string; argsSummary: string; ok: boolean; detail?: string }) => void
type LogFn = (level: "info" | "warn" | "error", scope: string, msg: string) => void

/** Was `run_command` darf — aus den Einstellungen, sonst die Vorgabe. */
export interface CommandPolicy {
	enabled: boolean
	allowed: string[]
	timeoutMs: number
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
	enabled: true,
	allowed: DEFAULT_ALLOWED_COMMANDS,
	timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
}

/** Führt einen Tool-Call in der Sandbox aus — nie werfend (Fehler werden gemeldet). */
export async function executeTool(
	baseDir: string,
	call: ToolCallRequest,
	emitOp: EmitToolCall,
	log: LogFn,
	policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
	signal?: AbortSignal,
): Promise<ToolOpResult> {
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
			case "run_command": {
				result = await runCommand(baseDir, args, policy, signal)
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

/**
 * Führt ein Programm im Arbeitsverzeichnis aus.
 *
 * Alle Grenzen an einer Stelle, damit keine davon versehentlich verlorengeht:
 * Erlaubnisliste, kein Pfad im Programmnamen, keine Shell, Sandbox als
 * Arbeitsverzeichnis, Argumente ohne Ausbruch, magere Umgebung, Frist,
 * gekappte Ausgabe. Fällt eine weg, sind die übrigen wertlos.
 */
async function runCommand(
	baseDir: string,
	args: Record<string, unknown>,
	policy: CommandPolicy,
	signal?: AbortSignal,
): Promise<ToolOpResult> {
	if (!policy.enabled) {
		return {
			ok: false,
			detail:
				"Befehle ausführen ist abgeschaltet (Einstellungen → Befehle ausführen). " +
				"Beschreibe stattdessen, was zu prüfen wäre.",
		}
	}

	const command = String(args.command ?? "").trim()
	// Der Programmname darf kein Pfad sein: `./skript` oder `/bin/sh` würden
	// die Erlaubnisliste umgehen.
	if (!command || command.includes("/") || command.includes("\\")) {
		return { ok: false, detail: `Ungültiges Programm: „${command}“ — nur Name, kein Pfad` }
	}
	if (!policy.allowed.includes(command)) {
		return {
			ok: false,
			detail:
				`„${command}“ steht nicht auf der Erlaubnisliste. Erlaubt: ${policy.allowed.join(", ")}. ` +
				"Die Liste steht in den Einstellungen — sie ändert der Mensch, nicht das Modell.",
		}
	}

	// Argumente: Liste bevorzugt. Ein einzelner String wird an Leerzeichen
	// getrennt — ohne Shell, also ohne Anführungszeichen-Magie.
	const list = Array.isArray(args.args)
		? args.args.map((a) => String(a))
		: String(args.args ?? "")
				.split(/\s+/)
				.filter((a) => a.length > 0)

	if (command === "git" && !GIT_READONLY.has(list[0] ?? "")) {
		return {
			ok: false,
			detail:
				`git ${list[0] ?? ""} ist nicht erlaubt — nur lesende Unterbefehle (${[...GIT_READONLY].join(", ")}). ` +
				"Was committet und gepusht wird, entscheidet der Mensch.",
		}
	}

	// Argumente, die wie ein Pfad aussehen, müssen im Arbeitsordner bleiben.
	for (const a of list) {
		if (a.startsWith("/") || a.startsWith("~") || a.split("/").includes("..")) {
			return { ok: false, detail: `Argument zeigt aus dem Workspace heraus: ${a}` }
		}
	}

	const { spawn } = await import("node:child_process")
	return await new Promise<ToolOpResult>((resolve) => {
		const child = spawn(command, list, {
			cwd: baseDir,
			// Keine Shell: Sonderzeichen bleiben Zeichen.
			shell: false,
			// Magere Umgebung: Was das Programm zum Laufen braucht, mehr nicht.
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				LANG: process.env.LANG ?? "C.UTF-8",
				TMPDIR: process.env.TMPDIR ?? "/tmp",
			},
		})

		let out = ""
		let gekappt = false
		const sammle = (chunk: Buffer) => {
			if (out.length >= MAX_OUTPUT_BYTES) {
				gekappt = true
				return
			}
			out += chunk.toString("utf8")
		}
		child.stdout?.on("data", sammle)
		child.stderr?.on("data", sammle)

		const frist = setTimeout(() => child.kill("SIGKILL"), policy.timeoutMs)
		const abbruch = () => child.kill("SIGKILL")
		signal?.addEventListener("abort", abbruch, { once: true })

		const fertig = (detail: string, ok: boolean) => {
			clearTimeout(frist)
			signal?.removeEventListener("abort", abbruch)
			resolve({ ok, detail })
		}

		child.on("error", (e) => fertig(`Start fehlgeschlagen: ${e.message}`, false))
		child.on("close", (code, sig) => {
			const text = out.slice(0, MAX_OUTPUT_BYTES).trimEnd()
			const rest = gekappt || out.length > MAX_OUTPUT_BYTES ? "\n[… Ausgabe gekappt]" : ""
			if (sig === "SIGKILL") {
				fertig(`Abgebrochen nach ${Math.round(policy.timeoutMs / 1000)} s.\n${text}${rest}`.trim(), false)
				return
			}
			const kopf = `${command} ${list.join(" ")} → Exit-Code ${code}`
			// Ein Exit-Code ≠ 0 ist **kein** Werkzeug-Fehler: Ein fehlgeschlagener
			// Test ist genau die Auskunft, die das Modell braucht.
			fertig(`${kopf}\n${text || "(keine Ausgabe)"}${rest}`, true)
		})
	})
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
