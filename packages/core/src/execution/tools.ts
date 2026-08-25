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
	// Ausführen & Bauen
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
	// Suchen & Ansehen — danach greift ein Modell als Erstes, um sich im
	// Projekt zurechtzufinden. Fehlten sie, scheiterte jeder solche Versuch.
	"grep",
	"rg",
	"find",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"diff",
	"git",
]

/**
 * Zerlegt eine Befehlszeile wie eine Shell es täte — **ohne** Shell.
 *
 * Anführungszeichen halten zusammen, was zusammengehört (`grep -r "json ld"`),
 * alles andere trennt an Leerzeichen. Damit versteht DiriZ die Schreibweise,
 * die Modelle tatsächlich verwenden, ohne die Gefahren einer Shell zu erben:
 * Das Ergebnis ist eine reine Argumentliste, keine ausgeführte Zeile.
 */
export function splitCommandLine(line: string): string[] {
	const out: string[] = []
	let aktuell = ""
	let quote: '"' | "'" | undefined
	for (const zeichen of line.trim()) {
		if (quote) {
			if (zeichen === quote) {
				quote = undefined
			} else {
				aktuell += zeichen
			}
			continue
		}
		if (zeichen === '"' || zeichen === "'") {
			quote = zeichen
			continue
		}
		if (/\s/.test(zeichen)) {
			if (aktuell.length > 0) {
				out.push(aktuell)
				aktuell = ""
			}
			continue
		}
		aktuell += zeichen
	}
	if (aktuell.length > 0) {
		out.push(aktuell)
	}
	return out
}

/**
 * Räumt Shell-Schreibweise aus einer Befehlszeile, statt sie abzuweisen.
 *
 * Modelle schreiben, was sie in jedem Terminal schreiben würden:
 * `grep -rn "sku" src/ 2>/dev/null | grep -v node_modules`. Ohne Shell ist
 * davon nichts ausführbar — abweisen kostet aber jedes Mal einen Schritt, und
 * beobachtet wurde genau das: drei Abweisungen in einem Lauf, jede vom Modell
 * brav korrigiert.
 *
 * Deshalb hier die stille Bereinigung, wo sie **nichts verändert**:
 *
 * - `2>/dev/null`, `2>&1` fallen weg — DiriZ sammelt stdout und stderr ohnehin.
 * - Ab `|`, `&&`, `||` oder `;` wird abgeschnitten: Der erste Befehl läuft, der
 *   Rest wäre nur Filterung oder Ausweichlogik. Die Ausgabe kommt vollständig,
 *   das Modell kann selbst filtern.
 *
 * Was entfernt wurde, steht im Ergebnis — stille Abweichungen wären schlimmer
 * als eine Abweisung.
 */
export function normalizeCommandLine(tokens: string[]): { tokens: string[]; entfernt: string[] } {
	const entfernt: string[] = []
	const out: string[] = []
	for (const t of tokens) {
		if (/^\d?>>?(&\d|\/dev\/null)?$/.test(t) || /^\d?>>?\/dev\/null$/.test(t) || t === "2>&1") {
			entfernt.push(t)
			continue
		}
		if (["|", "||", "&&", ";"].includes(t)) {
			entfernt.push(`${t} …`)
			break
		}
		out.push(t)
	}
	return { tokens: out, entfernt }
}

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
					// Modelle schicken gern absolute Pfade. Der Hinweis spart den
					// blinden zweiten Versuch.
					throw new Error(
						`Ungültiger Pfad: ${p} — Pfade sind relativ zum Workspace, ohne führenden „/" und ohne „..“.`,
					)
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
					throw new Error(
						`Ungültiger Pfad: ${p} — Pfade sind relativ zum Workspace, ohne führenden „/" und ohne „..“.`,
					)
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

	// Modelle schicken oft die **ganze Zeile** als `command`:
	// `grep -r "schema" src/ --include="*.vue"`. Das ist kein Fehlverhalten,
	// sondern die verbreitete Schreibweise — sie zurückzuweisen kostete in einem
	// beobachteten Lauf drei Versuche und den Abbruch. Also wird die Zeile hier
	// zerlegt: erstes Wort = Programm, Rest = Argumente. Anführungszeichen
	// halten zusammen, was zusammengehört; eine Shell ist weiterhin nicht im
	// Spiel.
	const roh = String(args.command ?? "").trim()
	const { tokens: zerlegt, entfernt } = normalizeCommandLine(splitCommandLine(roh))
	const command = zerlegt[0] ?? ""
	const ausZeile = zerlegt.slice(1)

	if (!command || command.includes("/") || command.includes("\\")) {
		return {
			ok: false,
			detail: `Ungültiges Programm: „${command}“ — nur der Programmname, kein Pfad (z. B. „node“).`,
		}
	}
	if (!policy.allowed.includes(command)) {
		return {
			ok: false,
			detail:
				`„${command}“ steht nicht auf der Erlaubnisliste. Erlaubt: ${policy.allowed.join(", ")}. ` +
				"Die Liste steht in den Einstellungen — sie ändert der Mensch, nicht das Modell.",
		}
	}

	// Argumente: was in der Zeile stand, plus was ausdrücklich übergeben wurde.
	const list = [
		...ausZeile,
		...(Array.isArray(args.args)
			? args.args.map((a) => String(a))
			: splitCommandLine(String(args.args ?? ""))),
	]

	// Was nach der Bereinigung noch nach Shell aussieht (etwa `<datei`), wird
	// benannt statt stumm durchgereicht. Geprüft werden **ganze Wörter**:
	// `()=>{}` in einem JavaScript-Schnipsel enthält ein `>`, ist aber keine
	// Umleitung.
	const verkettung = list.find((a) => /^(\||\|\||&&|;|<)$/.test(a))
	if (verkettung) {
		return {
			ok: false,
			detail:
				`„${verkettung}“ funktioniert hier nicht: Es gibt keine Shell, also keine Pipes, ` +
				"Umleitungen oder Verkettungen. Führe den Befehl ohne aus — die vollständige Ausgabe " +
				"bekommst du ohnehin (gekappt bei 32 kB).",
		}
	}

	// `find -exec`/`-delete` wäre eine Hintertür an der Erlaubnisliste vorbei.
	if (command === "find" && list.some((a) => ["-exec", "-execdir", "-delete", "-ok"].includes(a))) {
		return { ok: false, detail: "find darf hier nur suchen — kein -exec, -execdir, -delete oder -ok." }
	}

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
			const bereinigt =
				entfernt.length > 0
					? `\n[Ohne Shell ausgeführt — weggelassen: ${entfernt.join(" ")}. Die Ausgabe kommt vollständig.]`
					: ""
			const kopf = `${command} ${list.join(" ")} → Exit-Code ${code}${bereinigt}`
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
	if (call.name === "run_command") {
		// Was gelaufen ist, gehört in die Zeile — „(keine Argumente)" hilft
		// weder in der Oberfläche noch im Log bei der Fehlersuche.
		const rest = Array.isArray(args.args)
			? args.args.map((a) => String(a)).join(" ")
			: String(args.args ?? "")
		return `${String(args.command ?? "?")}${rest ? ` ${rest}` : ""}`.slice(0, 120)
	}
	return "(keine Argumente)"
}
