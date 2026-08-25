/**
 * Werkzeuge für den Agent-Loop — strikt in der Task-Sandbox.
 *
 * Lesen: `list_files`, `read_file`, `search_files`, `file_info`.
 * Ändern: `write_file`, `edit_file`, `append_file`, `delete_file`, `move_file`,
 * `copy_file`, `make_dir`. Ausführen: `run_command`.
 *
 * Der Satz ist mit Absicht vollständig. Fehlt ein Handgriff, baut ein Modell
 * ihn sich nach — und zwar schlecht: Ohne `edit_file` schreibt es zum Ändern
 * einer Zeile die ganze Datei neu (beobachtet: 51-mal dieselbe Datei), ohne
 * `search_files` liest es Datei für Datei durch, bis der Kontext voll ist.
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

/**
 * Max. Grösse einer Datei, die geändert werden darf (2 MB).
 *
 * Grosszügiger als `MAX_READ_BYTES`: Beim Ändern landet der Inhalt **nicht** im
 * Kontext, sondern nur die Meldung, was ersetzt wurde. Ein Deckel bleibt
 * trotzdem — eine 400-MB-Logdatei im Speicher zu spiegeln, hilft niemandem.
 */
const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** Max. Treffer einer Suche — danach steht im Ergebnis, dass gekappt wurde. */
const MAX_SEARCH_HITS = 100

/** Max. Einträge einer Dateiliste. */
const MAX_LIST_ENTRIES = 2000

/**
 * Verzeichnisse, die beim Auflisten und Suchen übersprungen werden.
 *
 * Ohne diese Liste lief `list_files` in einem Repository mit installierten
 * Abhängigkeiten durch `node_modules` — zehntausende Pfade, die den Kontext
 * füllen und in denen keine Antwort steht. Wer wirklich hineinsehen muss,
 * nennt den Pfad direkt (`list_files` mit `path`) oder nimmt `run_command`.
 */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".svn",
	"dist",
	"build",
	".next",
	".nuxt",
	".output",
	".cache",
	"coverage",
	"vendor",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".turbo",
	".gradle",
])

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
		description:
			"Listet die Dateien im Workspace (relative Pfade). Ohne `path` alles, sonst nur das " +
			"genannte Unterverzeichnis. Build- und Abhängigkeitsordner (node_modules, dist, .git …) " +
			"bleiben aussen vor.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Unterverzeichnis (optional, sonst der ganze Workspace)" },
			},
			required: [],
		},
	},
	{
		name: "read_file",
		description:
			"Liest eine Datei aus dem Workspace (relativer Pfad, max. 100 kB). Für grosse Dateien " +
			"abschnittsweise: `start_line` + `max_lines`.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relativer Dateipfad im Workspace" },
				start_line: { type: "number", description: "Erste Zeile (1-basiert, optional)" },
				max_lines: { type: "number", description: "Höchstens so viele Zeilen (optional)" },
			},
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
		name: "edit_file",
		description:
			"Ersetzt eine Textstelle in einer Datei — der Rest bleibt unangetastet. Für Änderungen an " +
			"bestehenden Dateien ist das der richtige Weg: `write_file` verlangt die ganze Datei und " +
			"vernichtet bei einem Tippfehler den übrigen Inhalt. `old_text` muss genau einmal vorkommen " +
			"(sonst `replace_all` setzen).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relativer Dateipfad im Workspace" },
				old_text: { type: "string", description: "Der zu ersetzende Text — exakt, mit Einrückung" },
				new_text: { type: "string", description: "Der neue Text (leer = löschen)" },
				replace_all: { type: "boolean", description: "Alle Vorkommen ersetzen statt nur eines" },
			},
			required: ["path", "old_text", "new_text"],
		},
	},
	{
		name: "append_file",
		description: "Hängt Text an eine Datei an (legt sie an, wenn sie fehlt).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relativer Dateipfad im Workspace" },
				content: { type: "string", description: "Der anzuhängende Text" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "delete_file",
		description:
			"Löscht eine Datei im Workspace. Ein Verzeichnis nur mit `recursive: true` — und dann " +
			"mitsamt Inhalt.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relativer Pfad im Workspace" },
				recursive: { type: "boolean", description: "Verzeichnis samt Inhalt löschen" },
			},
			required: ["path"],
		},
	},
	{
		name: "move_file",
		description: "Verschiebt oder benennt eine Datei bzw. ein Verzeichnis um (beides im Workspace).",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: "Bisheriger relativer Pfad" },
				to: { type: "string", description: "Neuer relativer Pfad" },
				overwrite: { type: "boolean", description: "Ein vorhandenes Ziel überschreiben" },
			},
			required: ["from", "to"],
		},
	},
	{
		name: "copy_file",
		description: "Kopiert eine Datei oder ein Verzeichnis innerhalb des Workspaces.",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: "Quelle (relativer Pfad)" },
				to: { type: "string", description: "Ziel (relativer Pfad)" },
				overwrite: { type: "boolean", description: "Ein vorhandenes Ziel überschreiben" },
			},
			required: ["from", "to"],
		},
	},
	{
		name: "make_dir",
		description: "Legt ein Verzeichnis an (mit allen Elternverzeichnissen).",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Relativer Pfad im Workspace" } },
			required: ["path"],
		},
	},
	{
		name: "search_files",
		description:
			"Sucht einen Text in allen Dateien des Workspaces und liefert Pfad, Zeilennummer und Zeile. " +
			"Schneller Weg zu „wo steht das?“, ohne Datei für Datei zu lesen.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Gesuchter Text (oder regulärer Ausdruck)" },
				path: { type: "string", description: "Nur in diesem Unterverzeichnis suchen (optional)" },
				regex: { type: "boolean", description: "`query` als regulären Ausdruck lesen" },
				ignore_case: { type: "boolean", description: "Gross-/Kleinschreibung ignorieren" },
			},
			required: ["query"],
		},
	},
	{
		name: "file_info",
		description:
			"Sagt, ob ein Pfad existiert, ob er Datei oder Verzeichnis ist, wie gross und wie viele " +
			"Zeilen — ohne den Inhalt in den Kontext zu holen.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Relativer Pfad im Workspace" } },
			required: ["path"],
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
				const unter = normalisierePfad(textArg(args, "path", "dir", "directory", "folder"))
				const wurzel = unter ? resolveInSandbox(baseDir, pfadPruefen(unter)) : baseDir
				if (unter && !fs.existsSync(wurzel)) {
					throw new Error(`Verzeichnis nicht gefunden: ${unter}`)
				}
				const alle = listFiles(wurzel)
				const gekappt = alle.slice(0, MAX_LIST_ENTRIES)
				const rest = alle.length - gekappt.length
				result = {
					ok: true,
					detail:
						(gekappt.join("\n") || "(leer)") +
						(rest > 0 ? `\n[… ${rest} weitere — grenze mit „path" ein oder nutze search_files.]` : ""),
				}
				break
			}
			case "read_file": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const abs = resolveInSandbox(baseDir, p)
				if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
					throw new Error(`Datei nicht gefunden: ${p}`)
				}
				const stat = fs.statSync(abs)
				const von = zahl(argOf(args, "start_line", "startLine", "offset", "from_line"))
				const wieviele = zahl(argOf(args, "max_lines", "maxLines", "limit", "num_lines"))
				if (stat.size > MAX_READ_BYTES && von === undefined && wieviele === undefined) {
					// Kein Sackgassen-Fehler mehr: Der Hinweis nennt den Ausweg,
					// sonst versucht ein Modell dieselbe Datei ein zweites Mal.
					throw new Error(
						`Datei zu groß (${Math.round(stat.size / 1024)} kB, max. ${MAX_READ_BYTES / 1024} kB) — ` +
							"lies sie abschnittsweise mit `start_line` und `max_lines`, oder suche gezielt mit `search_files`.",
					)
				}
				const roh = fs.readFileSync(abs, "utf8")
				if (von === undefined && wieviele === undefined) {
					result = { ok: true, detail: roh }
					break
				}
				const zeilen = roh.split(/\r?\n/)
				const start = Math.max(1, von ?? 1)
				const ende = Math.min(zeilen.length, start - 1 + (wieviele ?? zeilen.length))
				const teil = zeilen.slice(start - 1, ende)
				if (teil.length === 0) {
					throw new Error(`Ab Zeile ${start} steht nichts mehr — die Datei hat ${zeilen.length} Zeilen.`)
				}
				result = {
					ok: true,
					// Mit Zeilennummern, damit ein anschliessendes `edit_file`
					// weiss, worauf es sich bezieht.
					detail:
						teil.map((z, i) => `${start + i}: ${z}`).join("\n") +
						(ende < zeilen.length ? `\n[… bis Zeile ${zeilen.length}]` : ""),
				}
				break
			}
			case "write_file": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const rohInhalt = argOf(args, "content", "text", "contents", "data")
				const content = typeof rohInhalt === "string" ? rohInhalt : JSON.stringify(rohInhalt ?? "")
				const abs = resolveInSandbox(baseDir, p)
				fs.mkdirSync(path.dirname(abs), { recursive: true })
				fs.writeFileSync(abs, content, "utf8")
				result = { ok: true, detail: `Geschrieben: ${p} (${Buffer.byteLength(content)} Bytes)` }
				break
			}
			case "edit_file": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const abs = resolveInSandbox(baseDir, p)
				if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
					throw new Error(`Datei nicht gefunden: ${p} — mit write_file anlegen.`)
				}
				if (fs.statSync(abs).size > MAX_EDIT_BYTES) {
					throw new Error(`Datei zu groß zum Ändern (max. ${MAX_EDIT_BYTES / 1024 / 1024} MB)`)
				}
				const alt = textArg(args, "old_text", "old_string", "search", "find", "from")
				const neu = textArg(args, "new_text", "new_string", "replace", "replacement", "to")
				const alleErsetzen = jaNein(argOf(args, "replace_all", "replaceAll", "all", "global"))
				if (alt.length === 0) {
					throw new Error("`old_text` ist leer — nenne den Text, der ersetzt werden soll.")
				}
				if (alt === neu) {
					throw new Error("`old_text` und `new_text` sind gleich — der Aufruf würde nichts ändern.")
				}
				const inhalt = fs.readFileSync(abs, "utf8")
				const treffer = zaehleVorkommen(inhalt, alt)
				if (treffer === 0) {
					// Der häufigste Grund ist Einrückung. Das zu sagen, spart den
					// blinden zweiten Versuch mit demselben Text.
					throw new Error(
						`Text nicht gefunden in ${p}. Er muss **exakt** übereinstimmen, samt Einrückung und ` +
							"Zeilenumbrüchen — lies die Stelle mit read_file und kopiere sie wörtlich.",
					)
				}
				if (treffer > 1 && !alleErsetzen) {
					throw new Error(
						`Text kommt ${treffer}-mal vor in ${p}. Nimm mehr Zeilen dazu, damit die Stelle ` +
							"eindeutig ist — oder setze `replace_all: true`, wenn alle gemeint sind.",
					)
				}
				const geaendert = alleErsetzen ? inhalt.split(alt).join(neu) : inhalt.replace(alt, neu)
				fs.writeFileSync(abs, geaendert, "utf8")
				const diff = Buffer.byteLength(geaendert) - Buffer.byteLength(inhalt)
				result = {
					ok: true,
					detail: `Ersetzt in ${p}: ${treffer > 1 && alleErsetzen ? `${treffer} Stellen` : "1 Stelle"} (${diff >= 0 ? "+" : ""}${diff} Bytes)`,
				}
				break
			}
			case "append_file": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const abs = resolveInSandbox(baseDir, p)
				const content = textArg(args, "content", "text", "contents", "data")
				fs.mkdirSync(path.dirname(abs), { recursive: true })
				const gabEs = fs.existsSync(abs)
				fs.appendFileSync(abs, content, "utf8")
				result = {
					ok: true,
					detail: `${gabEs ? "Angehängt an" : "Angelegt"}: ${p} (+${Buffer.byteLength(content)} Bytes)`,
				}
				break
			}
			case "delete_file": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const abs = resolveInSandbox(baseDir, p)
				if (abs === baseDir) {
					throw new Error("Der Workspace selbst wird nicht gelöscht.")
				}
				if (!fs.existsSync(abs)) {
					throw new Error(`Nicht gefunden: ${p}`)
				}
				const istOrdner = fs.statSync(abs).isDirectory()
				if (istOrdner && !jaNein(argOf(args, "recursive", "force", "rekursiv"))) {
					const drin = fs.readdirSync(abs).length
					if (drin > 0) {
						throw new Error(
							`${p} ist ein Verzeichnis mit ${drin} Einträgen. Wenn es wirklich samt Inhalt weg soll, ` +
								"setze `recursive: true`.",
						)
					}
				}
				fs.rmSync(abs, { recursive: istOrdner, force: false })
				result = { ok: true, detail: `Gelöscht: ${p}${istOrdner ? " (Verzeichnis)" : ""}` }
				break
			}
			case "move_file":
			case "copy_file": {
				const von = pfadPruefen(textArg(args, "from", "source", "src", "old_path", "path"), "from")
				const nach = pfadPruefen(textArg(args, "to", "target", "destination", "dest", "new_path"), "to")
				const ueberschreiben = jaNein(argOf(args, "overwrite", "force", "replace"))
				const absVon = resolveInSandbox(baseDir, von)
				const absNach = resolveInSandbox(baseDir, nach)
				if (!fs.existsSync(absVon)) {
					throw new Error(`Quelle nicht gefunden: ${von}`)
				}
				if (absVon === absNach) {
					throw new Error("Quelle und Ziel sind derselbe Pfad.")
				}
				if (fs.existsSync(absNach) && !ueberschreiben) {
					throw new Error(`${nach} gibt es bereits — setze \`overwrite: true\`, wenn es ersetzt werden soll.`)
				}
				const istOrdner = fs.statSync(absVon).isDirectory()
				if (istOrdner && absNach.startsWith(absVon + path.sep)) {
					throw new Error(`${nach} liegt in ${von} — ein Verzeichnis kann nicht in sich selbst wandern.`)
				}
				fs.mkdirSync(path.dirname(absNach), { recursive: true })
				if (call.name === "move_file") {
					fs.rmSync(absNach, { recursive: true, force: true })
					fs.renameSync(absVon, absNach)
					result = { ok: true, detail: `Verschoben: ${von} → ${nach}` }
				} else {
					fs.cpSync(absVon, absNach, { recursive: istOrdner, force: true })
					result = { ok: true, detail: `Kopiert: ${von} → ${nach}` }
				}
				break
			}
			case "make_dir": {
				const p = pfadPruefen(textArg(args, "path", "dir", "directory", "folder"))
				const abs = resolveInSandbox(baseDir, p)
				if (fs.existsSync(abs)) {
					if (!fs.statSync(abs).isDirectory()) {
						throw new Error(`${p} gibt es bereits — als Datei, nicht als Verzeichnis.`)
					}
					result = { ok: true, detail: `Gibt es bereits: ${p}` }
					break
				}
				fs.mkdirSync(abs, { recursive: true })
				result = { ok: true, detail: `Angelegt: ${p}` }
				break
			}
			case "search_files": {
				result = searchFiles(baseDir, args)
				break
			}
			case "file_info": {
				const p = pfadPruefen(textArg(args, "path", "file", "filename", "file_path"))
				const abs = resolveInSandbox(baseDir, p)
				if (!fs.existsSync(abs)) {
					result = { ok: true, detail: `${p}: existiert nicht` }
					break
				}
				const st = fs.statSync(abs)
				if (st.isDirectory()) {
					const drin = fs.readdirSync(abs).length
					result = { ok: true, detail: `${p}: Verzeichnis, ${drin} Einträge` }
					break
				}
				const zeilen =
					st.size <= MAX_EDIT_BYTES ? fs.readFileSync(abs, "utf8").split(/\r?\n/).length : undefined
				result = {
					ok: true,
					detail: `${p}: Datei, ${st.size} Bytes${zeilen !== undefined ? `, ${zeilen} Zeilen` : ""}, geändert ${st.mtime.toISOString()}`,
				}
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
				if (SKIP_DIRS.has(entry.name)) {
					continue
				}
				walk(path.join(d, entry.name), rel)
			} else if (entry.isFile()) {
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

/**
 * Bringt einen Pfad in die Form, die DiriZ erwartet — statt ihn abzuweisen.
 *
 * Ein Modell schreibt den Pfad so, wie es ihn in jedem Terminal schreiben
 * würde. Beobachtet, jedes Mal als roter Fehlschlag im Lauf:
 *
 * - `.` und `./` für „hier" — der häufigste Fall bei `list_files`/`search_files`
 * - `./src/a.js` mit führendem Punkt
 * - `/src/a.js` mit führendem Schrägstrich (gemeint ist die Workspace-Wurzel)
 * - `src/` mit Schrägstrich am Ende
 * - `src\\a.js` mit Backslashes
 *
 * Keine dieser Formen ist mehrdeutig, keine führt aus der Sandbox heraus — sie
 * abzuweisen kostet nur einen Schritt und lehrt nichts. `..` bleibt verboten:
 * Das **ist** mehrdeutig, und der Ausbruchsversuch gehört benannt.
 */
export function normalisierePfad(p: string): string {
	let out = p.trim().replace(/\\/g, "/")
	// Führender Schrägstrich: gemeint ist die Wurzel des Workspaces, nicht die
	// des Rechners — dorthin käme das Modell ohnehin nicht.
	out = out.replace(/^\/+/, "")
	while (out.startsWith("./")) {
		out = out.slice(2)
	}
	out = out
		.replace(/\/\.\//g, "/")
		.replace(/\/+/g, "/")
		.replace(/\/+$/, "")
	return out === "." ? "" : out
}

/**
 * Prüft einen Pfad aus einem Werkzeugaufruf — mit einer Meldung, die weiterhilft.
 *
 * Liefert den **bereinigten** Pfad zurück; alles Weitere rechnet damit.
 */
function pfadPruefen(p: string, feld = "path"): string {
	const sauber = normalisierePfad(p)
	if (!sauber) {
		throw new Error(`\`${feld}\` fehlt — nenne einen relativen Pfad im Workspace.`)
	}
	if (!isSafeRelPath(sauber)) {
		throw new Error(
			`Ungültiger Pfad (${feld}): ${p} — Pfade sind relativ zum Workspace und dürfen kein „..“ enthalten.`,
		)
	}
	return sauber
}

/**
 * Das erste belegte Argument aus einer Reihe von Namen.
 *
 * Modelle halten sich nicht immer an das Schema: `old_string` statt
 * `old_text`, `pattern` statt `query`, `source`/`destination` statt
 * `from`/`to`. Das sind keine Fehler, sondern die Schreibweisen anderer
 * Werkzeugsätze, auf die sie trainiert wurden. Sie anzunehmen kostet eine
 * Zeile — sie abzuweisen kostet einen Schritt.
 */
function argOf(args: Record<string, unknown>, ...namen: string[]): unknown {
	for (const n of namen) {
		const v = args[n]
		if (v !== undefined && v !== null && v !== "") {
			return v
		}
	}
	return undefined
}

/** Text-Argument unter mehreren möglichen Namen. */
function textArg(args: Record<string, unknown>, ...namen: string[]): string {
	const v = argOf(args, ...namen)
	return v === undefined ? "" : typeof v === "string" ? v : String(v)
}

/**
 * Ja/Nein aus einem Werkzeug-Argument.
 *
 * `true`, `"true"`, `"yes"` und `1` meinen alle dasselbe. Ein Modell, das
 * `"true"` schickt, hat sich entschieden — das an einem Typ scheitern zu
 * lassen, wäre Rechthaberei.
 */
function jaNein(v: unknown): boolean {
	if (typeof v === "boolean") {
		return v
	}
	if (typeof v === "number") {
		return v === 1
	}
	if (typeof v === "string") {
		return ["true", "yes", "ja", "1"].includes(v.trim().toLowerCase())
	}
	return false
}

/** Zahl aus einem Werkzeug-Argument, oder `undefined` bei Unsinn. */
function zahl(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
	return Number.isFinite(n) ? n : undefined
}

/** Wie oft kommt `teil` in `text` vor? (Ohne Regex — der Text ist wörtlich gemeint.) */
function zaehleVorkommen(text: string, teil: string): number {
	let n = 0
	let ab = text.indexOf(teil)
	while (ab !== -1) {
		n++
		ab = text.indexOf(teil, ab + teil.length)
	}
	return n
}

/**
 * Sucht Text in den Dateien des Workspaces.
 *
 * Warum eingebaut, obwohl `grep` auf der Erlaubnisliste steht: `grep` hängt an
 * der Erlaubnisliste und an der jeweiligen Maschine, kennt die
 * Sandbox-Grenzen nicht und liefert bei binären Dateien Kauderwelsch. Diese
 * Suche überspringt dieselben Verzeichnisse wie `list_files`, hält sich an die
 * Sandbox und kappt sauber.
 */
function searchFiles(baseDir: string, args: Record<string, unknown>): ToolOpResult {
	const query = textArg(args, "query", "pattern", "text", "search", "needle")
	if (!query) {
		throw new Error("`query` fehlt — nenne den gesuchten Text.")
	}
	const unter = normalisierePfad(textArg(args, "path", "dir", "directory", "folder"))
	const wurzel = unter ? resolveInSandbox(baseDir, pfadPruefen(unter)) : baseDir
	if (!fs.existsSync(wurzel)) {
		throw new Error(`Nicht gefunden: ${unter}`)
	}
	const flags = jaNein(argOf(args, "ignore_case", "ignoreCase", "case_insensitive")) ? "i" : ""
	let muster: RegExp
	try {
		const alsRegex = jaNein(argOf(args, "regex", "is_regex", "use_regex"))
		muster = new RegExp(alsRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
	} catch (e) {
		throw new Error(`Ungültiger regulärer Ausdruck: ${e instanceof Error ? e.message : String(e)}`)
	}

	const dateien = fs.statSync(wurzel).isFile() ? [path.basename(wurzel)] : listFiles(wurzel)
	const basis = fs.statSync(wurzel).isFile() ? path.dirname(wurzel) : wurzel
	const vorne = unter && !fs.statSync(wurzel).isFile() ? `${unter.replace(/\/$/, "")}/` : ""
	const treffer: string[] = []
	let durchsucht = 0
	for (const rel of dateien) {
		if (treffer.length >= MAX_SEARCH_HITS) {
			break
		}
		const abs = path.join(basis, rel)
		let inhalt: string
		try {
			if (fs.statSync(abs).size > MAX_EDIT_BYTES) {
				continue
			}
			inhalt = fs.readFileSync(abs, "utf8")
		} catch {
			continue
		}
		// Binärdateien überspringen: Ein Null-Byte in den ersten Kilobytes ist
		// das verlässlichste Zeichen dafür.
		if (inhalt.slice(0, 4096).includes("\u0000")) {
			continue
		}
		durchsucht++
		const zeilen = inhalt.split(/\r?\n/)
		for (let i = 0; i < zeilen.length; i++) {
			if (!muster.test(zeilen[i])) {
				continue
			}
			treffer.push(`${vorne}${rel}:${i + 1}: ${zeilen[i].trim().slice(0, 200)}`)
			if (treffer.length >= MAX_SEARCH_HITS) {
				break
			}
		}
	}
	if (treffer.length === 0) {
		return { ok: true, detail: `Keine Treffer für „${query}“ (${durchsucht} Dateien durchsucht).` }
	}
	return {
		ok: true,
		detail:
			treffer.join("\n") +
			(treffer.length >= MAX_SEARCH_HITS
				? `\n[… bei ${MAX_SEARCH_HITS} Treffern gekappt — suche genauer.]`
				: `\n(${treffer.length} Treffer in ${durchsucht} Dateien)`),
	}
}

/**
 * Werkzeuge, die den Workspace **verändern**.
 *
 * Der Agent-Loop braucht diese Unterscheidung an zwei Stellen: Ein gelesener
 * Inhalt darf nach einer Änderung nicht mehr aus dem Verlauf beantwortet
 * werden, und ein Befehl, der nach einer Änderung wiederholt wird, ist echte
 * Arbeit statt einer Schleife. Steht hier, weil hier auch die Werkzeuge stehen
 * — eine zweite Liste anderswo wäre beim nächsten Werkzeug schon veraltet.
 */
export const MUTATING_TOOLS = new Set([
	"write_file",
	"edit_file",
	"append_file",
	"delete_file",
	"move_file",
	"copy_file",
	"make_dir",
])

/** Nur-lesende Werkzeuge — ihr Ergebnis darf aus dem Verlauf kommen. */
export const READING_TOOLS = new Set(["list_files", "read_file", "search_files", "file_info"])

/**
 * Welche Pfade ein Aufruf berührt — für das Verwerfen veralteter Lese-Antworten.
 *
 * Leer heisst „keiner“; `undefined` heisst „unbekannt, alles verwerfen“. Der
 * Unterschied zählt: Ein `run_command` kann jede Datei geändert haben.
 */
export function touchedPaths(call: ToolCallRequest): string[] | undefined {
	const args = call.arguments ?? {}
	if (!MUTATING_TOOLS.has(call.name)) {
		return []
	}
	const raus: string[] = []
	for (const feld of ["path", "from", "to"]) {
		const v = args[feld]
		if (typeof v === "string" && v.length > 0) {
			raus.push(v)
		}
	}
	return raus
}

/** Kurze Zusammenfassung der Argumente für Event/Log (ohne großen Content). */
function summarizeArgs(call: ToolCallRequest): string {
	const args = call.arguments ?? {}
	if (call.name === "write_file" || call.name === "append_file") {
		const len = typeof args.content === "string" ? Buffer.byteLength(args.content) : 0
		return `${args.path ?? "?"} (${len} Bytes)`
	}
	if (call.name === "edit_file") {
		const alt = typeof args.old_text === "string" ? args.old_text : ""
		const kurz = alt.split(/\r?\n/)[0]?.trim().slice(0, 40) ?? ""
		return `${args.path ?? "?"}${kurz ? ` („${kurz}${alt.length > kurz.length ? "…" : ""}")` : ""}`
	}
	if (call.name === "move_file" || call.name === "copy_file") {
		return `${args.from ?? "?"} → ${args.to ?? "?"}`
	}
	if (call.name === "search_files") {
		return `„${String(args.query ?? "?").slice(0, 60)}"${args.path ? ` in ${args.path}` : ""}`
	}
	if (call.name === "list_files") {
		return String(args.path ?? "—")
	}
	if (call.name === "read_file") {
		const von = args.start_line
		return `${String(args.path ?? "?")}${von ? ` ab Zeile ${von}` : ""}`
	}
	if (call.name === "delete_file" || call.name === "make_dir" || call.name === "file_info") {
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
