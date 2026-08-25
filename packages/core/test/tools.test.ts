/**
 * Sandbox-Tests für die Werkzeuge (list/read/write/run).
 * Fokus: Pfad-Sicherheit (Traversal), korrekte Ergebnisse — und beim
 * Ausführen von Befehlen vor allem das, was **nicht** gehen darf.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AGENT_TOOLS, type ToolCallRequest } from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	appendToolCall,
	backfillToolInDocs,
	createProvider,
	createTask,
	getInstanceDoc,
	listToolCallsByTask,
	saveInstanceDoc,
	upsertInstance,
} from "../src/db/repositories.js"
import { executeTool, normalisierePfad, TOOL_SPECS } from "../src/execution/tools.js"

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-tools-"))
const ops: { name: string; ok: boolean }[] = []
const emitOp = (data: { name: string; argsSummary: string; ok: boolean }) => {
	ops.push(data)
}
const log = () => {}

function call(name: string, arguments_: Record<string, unknown>): ToolCallRequest {
	return { id: `t_${name}`, name, arguments: arguments_ }
}

describe("tools: Sandbox", () => {
	it("definiert den vollständigen Dateizugriff mit JSON-Schemas", async () => {
		// Lesen, Ändern, Ausführen — der Satz muss vollständig sein, sonst baut
		// sich ein Modell den fehlenden Handgriff schlecht nach.
		expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual([
			"append_file",
			"copy_file",
			"delete_file",
			"edit_file",
			"file_info",
			"list_files",
			"make_dir",
			"move_file",
			"read_file",
			"run_command",
			"search_files",
			"write_file",
		])
		// Und er muss sich mit dem Katalog decken, aus dem die Datenblätter
		// entstehen — sonst wäre ein Werkzeug still gesperrt.
		expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual([...AGENT_TOOLS].sort())
		for (const spec of TOOL_SPECS) {
			expect(spec.parameters.type).toBe("object")
			expect(spec.description.length).toBeGreaterThan(0)
		}
	})

	it("schreibt und liest Dateien in der Sandbox", async () => {
		const w = await executeTool(
			baseDir,
			call("write_file", { path: "src/hello.txt", content: "hallo diriz" }),
			emitOp,
			log,
		)
		expect(w.ok).toBe(true)
		expect(fs.readFileSync(path.join(baseDir, "src/hello.txt"), "utf8")).toBe("hallo diriz")

		const r = await executeTool(baseDir, call("read_file", { path: "src/hello.txt" }), emitOp, log)
		expect(r.ok).toBe(true)
		expect(r.detail).toBe("hallo diriz")
	})

	it("listet Dateien rekursiv (sortiert)", async () => {
		await executeTool(baseDir, call("write_file", { path: "a/b.txt", content: "x" }), emitOp, log)
		const r = await executeTool(baseDir, call("list_files", {}), emitOp, log)
		expect(r.ok).toBe(true)
		const lines = r.detail.split("\n")
		expect(lines).toContain("src/hello.txt")
		expect(lines).toContain("a/b.txt")
	})

	it("blockt Pfad-Traversals beim Lesen", async () => {
		for (const p of ["../../etc/passwd", "/etc/passwd", "..\\evil"]) {
			const r = await executeTool(baseDir, call("read_file", { path: p }), emitOp, log)
			expect(r.ok).toBe(false)
		}
	})

	it("blockt Pfad-Traversals beim Schreiben (Datei bleibt in der Sandbox)", async () => {
		const escapedPath = path.join(os.tmpdir(), `diriz-escape-${Date.now()}.txt`)
		const r = await executeTool(
			baseDir,
			call("write_file", { path: `../../${path.basename(escapedPath)}`, content: "x" }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(false)
		expect(fs.existsSync(escapedPath)).toBe(false)
	})

	it("meldet fehlende Dateien und unbekannte Tools als Fehler (kein Wurf)", async () => {
		const missing = await executeTool(baseDir, call("read_file", { path: "keine/datei.txt" }), emitOp, log)
		expect(missing.ok).toBe(false)
		expect(missing.detail).toContain("nicht gefunden")

		const unknown = await executeTool(baseDir, call("delete_everything", {}), emitOp, log)
		expect(unknown.ok).toBe(false)
	})

	it("emittiert jede Operation (Transparenz)", async () => {
		expect(ops.length).toBeGreaterThan(0)
		for (const op of ops) {
			expect(op.name).toBeTruthy()
		}
	})
})

/**
 * Tool-Operationen müssen ein Neuladen überleben: Der SSE-Stream erreicht nur,
 * wer gerade zusieht. Ohne Persistenz sähe man nach einem Reload nicht mehr,
 * was das Modell tut — und im Verlauf von gestern gar nichts mehr.
 */
describe("Tool-Operationen werden festgehalten", () => {
	it("speichert sie in Reihenfolge und liefert sie zur Task", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-toolcalls-"))
		const db = openDatabase(dir)
		migrate(db)
		const task = createTask(db, { prompt: "Dateien anfassen", title: "Tool-Test" })

		appendToolCall(db, {
			executionId: "e1",
			taskId: task.id,
			name: "list_files",
			argsSummary: "(keine Argumente)",
			ok: true,
		})
		appendToolCall(db, {
			executionId: "e1",
			taskId: task.id,
			name: "read_file",
			argsSummary: "src/app.ts",
			ok: true,
		})
		appendToolCall(db, {
			executionId: "e1",
			taskId: task.id,
			name: "write_file",
			argsSummary: "src/app.ts",
			ok: false,
			detail: "kein Schreibrecht",
		})

		const calls = listToolCallsByTask(db, task.id)
		expect(calls.map((c) => c.name)).toEqual(["list_files", "read_file", "write_file"])
		expect(calls.map((c) => c.seq)).toEqual([1, 2, 3])
		expect(calls[2].ok).toBe(false)
		expect(calls[2].detail).toBe("kein Schreibrecht")

		db.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})
})

/**
 * `run_command` ist das schärfste Werkzeug im Haus: Es läuft im
 * Arbeitsverzeichnis eines echten Repositories, neben `.env`-Dateien und einem
 * Git-Remote. Geprüft wird deshalb zuerst, was **nicht** geht.
 */
describe("tools: Befehle ausführen", () => {
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-run-"))

	it("führt ein erlaubtes Programm aus und liefert seine Ausgabe", async () => {
		const r = await executeTool(
			runDir,
			call("run_command", { command: "node", args: ["-e", "console.log('hallo aus node')"] }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("hallo aus node")
		expect(r.detail).toContain("Exit-Code 0")
	})

	it("meldet einen fehlgeschlagenen Lauf als Ergebnis, nicht als Werkzeug-Fehler", async () => {
		// Ein fehlgeschlagener Test ist genau die Auskunft, die das Modell braucht.
		const r = await executeTool(
			runDir,
			call("run_command", { command: "node", args: ["-e", "process.exit(3)"] }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("Exit-Code 3")
	})

	it("lässt nur Programme von der Erlaubnisliste zu", async () => {
		for (const verboten of ["rm", "curl", "sh", "bash", "sudo", "ssh"]) {
			const r = await executeTool(runDir, call("run_command", { command: verboten }), emitOp, log)
			expect(r.ok, verboten).toBe(false)
			expect(r.detail, verboten).toContain("Erlaubnisliste")
		}
	})

	it("verweigert Programmnamen mit Pfad — sonst wäre die Liste wertlos", async () => {
		for (const pfad of ["/bin/sh", "./skript.sh", "../node"]) {
			const r = await executeTool(runDir, call("run_command", { command: pfad }), emitOp, log)
			expect(r.ok, pfad).toBe(false)
		}
	})

	it("kennt keine Shell — und sagt das, statt still etwas anderes zu tun", async () => {
		// Ohne Shell wäre `;` bloss ein Argument. Das stumm durchzureichen liefert
		// ein rätselhaftes Ergebnis; deshalb wird es benannt. Gelöscht wird nichts.
		const opfer = path.join(runDir, "nicht-loeschen.txt")
		fs.writeFileSync(opfer, "ich bleibe")
		const r = await executeTool(
			runDir,
			call("run_command", {
				command: "node",
				args: ["-e", "console.log('a')", ";", "rm", "-rf", "nicht-loeschen.txt"],
			}),
			emitOp,
			log,
		)
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("keine Shell")
		expect(fs.existsSync(opfer)).toBe(true)
	})

	it("versteht eine ganze Befehlszeile in `command` — so schreiben es Modelle", async () => {
		// Beobachtet: `grep -r "schema" src/` als ein einziger String. Früher
		// dreimal abgewiesen („nur Name, kein Pfad"), dann Abbruch.
		fs.mkdirSync(path.join(runDir, "src"), { recursive: true })
		fs.writeFileSync(path.join(runDir, "src", "a.js"), 'const schema = "json-ld"')
		const r = await executeTool(runDir, call("run_command", { command: 'grep -r "schema" src' }), emitOp, log)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("json-ld")
	})

	it("führt eine Zeile mit Pipe aus, statt sie abzuweisen — ohne die Pipe", async () => {
		// Modelle schreiben Terminal-Syntax. Abweisen kostet jedes Mal einen
		// Schritt; der Teil vor der Pipe ist aber genau das, was gemeint war.
		const r = await executeTool(
			runDir,
			call("run_command", { command: 'grep -r "schema" src | head -5' }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("json-ld")
		// Und es steht dabei, was weggelassen wurde — keine stille Abweichung.
		expect(r.detail).toContain("weggelassen")
	})

	it("lässt `2>/dev/null` weg, statt daran zu scheitern", async () => {
		const r = await executeTool(
			runDir,
			call("run_command", { command: 'grep -r "schema" src 2>/dev/null' }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("json-ld")
	})

	it("führt bei `||` nur den ersten Befehl aus", async () => {
		const r = await executeTool(
			runDir,
			call("run_command", { command: 'ls src || echo "nichts"' }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("a.js")
		expect(r.detail).not.toContain("nichts")
	})

	it("lässt find nicht ausführen oder löschen", async () => {
		for (const arg of ["-exec", "-delete"]) {
			const r = await executeTool(
				runDir,
				call("run_command", { command: `find . -name "*.js" ${arg}` }),
				emitOp,
				log,
			)
			expect(r.ok, arg).toBe(false)
			expect(r.detail, arg).toContain("nur suchen")
		}
	})

	it("lässt bei git nur lesende Unterbefehle zu", async () => {
		const lesend = await executeTool(
			runDir,
			call("run_command", { command: "git", args: ["status"] }),
			emitOp,
			log,
		)
		// Kein Repository — aber der Aufruf wurde nicht von der Regel geblockt.
		expect(lesend.detail).not.toContain("nicht erlaubt")

		for (const schreibend of ["push", "reset", "clean", "config", "remote"]) {
			const r = await executeTool(
				runDir,
				call("run_command", { command: "git", args: [schreibend] }),
				emitOp,
				log,
			)
			expect(r.ok, schreibend).toBe(false)
			expect(r.detail, schreibend).toContain("nicht erlaubt")
		}
	})

	it("lässt keine Argumente zu, die aus dem Workspace zeigen", async () => {
		for (const arg of ["~/.ssh/id_rsa", "../../geheim.txt", "src/../../weg.txt"]) {
			const r = await executeTool(runDir, call("run_command", { command: "node", args: [arg] }), emitOp, log)
			expect(r.ok, arg).toBe(false)
			expect(r.detail, arg).toContain("Workspace")
		}
	})

	it("bezieht einen absoluten Pfad auf den Workspace — und sagt es", async () => {
		// `/etc/passwd` liest hier `<workspace>/etc/passwd`, also nichts. Das
		// stumm zu tun wäre schlimm: „Datei nicht gefunden" liest sich wie eine
		// fehlende Datei, nicht wie eine fehlende Welt.
		const r = await executeTool(
			runDir,
			call("run_command", { command: "cat", args: ["/etc/passwd"] }),
			emitOp,
			log,
		)
		expect(r.detail).toContain("auf den Workspace bezogen")
		expect(r.detail).not.toContain("root:")
	})

	it("bricht ab, wenn die Frist abläuft", async () => {
		const r = await executeTool(
			runDir,
			call("run_command", { command: "node", args: ["-e", "setTimeout(()=>{}, 60000)"] }),
			emitOp,
			log,
			{ enabled: true, allowed: ["node"], timeoutMs: 400 },
		)
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("Abgebrochen")
	})

	it("lässt sich abschalten — dann sagt es das auch", async () => {
		const r = await executeTool(runDir, call("run_command", { command: "node", args: ["-v"] }), emitOp, log, {
			enabled: false,
			allowed: ["node"],
			timeoutMs: 1000,
		})
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("abgeschaltet")
	})

	it("gibt dem Programm nur eine magere Umgebung mit", async () => {
		process.env.DIRIZ_GEHEIMNIS = "darf-das-modell-nicht-sehen"
		const r = await executeTool(
			runDir,
			call("run_command", {
				command: "node",
				args: ["-e", "console.log(process.env.DIRIZ_GEHEIMNIS ?? 'nicht gesetzt')"],
			}),
			emitOp,
			log,
		)
		process.env.DIRIZ_GEHEIMNIS = undefined
		expect(r.detail).toContain("nicht gesetzt")
	})
})

/**
 * Ein neues Werkzeug darf im Bestand nicht still gesperrt bleiben — aber eine
 * bewusste Abwahl muss stehen bleiben. Beides prüft dieser Test.
 */
describe("Werkzeug im Bestand nachtragen", () => {
	it("ergänzt unveränderte Datenblätter und lässt bearbeitete in Ruhe", () => {
		const db2 = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "diriz-backfill-")))
		migrate(db2)
		const provider = createProvider(db2, { type: "ollama", label: "P", baseUrl: "http://x" })
		const unberührt = upsertInstance(
			db2,
			provider.id,
			{ modelId: "m-alt", displayName: "Alt", contextWindow: 8192 },
			"manual",
		)
		const bearbeitet = upsertInstance(
			db2,
			provider.id,
			{ modelId: "m-eigen", displayName: "Eigen", contextWindow: 8192 },
			"manual",
		)

		// Beide auf den alten Stand bringen: drei Werkzeuge …
		const altesBlatt = [
			"# llm.md",
			"",
			"## Werkzeuge",
			"",
			"- list_files — listet",
			"- read_file — liest",
			"- write_file — schreibt",
			"",
		].join("\n")
		saveInstanceDoc(db2, unberührt.id, "llm", altesBlatt)
		// … und eines, aus dem jemand `write_file` gestrichen hat.
		saveInstanceDoc(db2, bearbeitet.id, "llm", altesBlatt.replace("- write_file — schreibt\n", ""))

		const ergänzt = backfillToolInDocs(db2, "run_command", "führt aus", [
			"list_files",
			"read_file",
			"write_file",
		])
		expect(ergänzt).toBe(1)

		expect(getInstanceDoc(db2, unberührt.id, "llm")?.content).toContain("- run_command")
		// Die bewusste Abwahl bleibt unangetastet.
		expect(getInstanceDoc(db2, bearbeitet.id, "llm")?.content).not.toContain("run_command")

		// Zweiter Lauf trägt nichts erneut nach.
		expect(
			backfillToolInDocs(db2, "run_command", "führt aus", ["list_files", "read_file", "write_file"]),
		).toBe(0)
		db2.close()
	})
})

describe("tools: vollständiger Dateizugriff", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-fileio-"))
	const run = (name: string, args: Record<string, unknown>) => executeTool(dir, call(name, args), emitOp, log)

	it("ändert eine Stelle, statt die ganze Datei zu überschreiben", async () => {
		fs.writeFileSync(path.join(dir, "preise.js"), "const mwst = 1.077\nconst rabatt = 0.1\n")
		const r = await run("edit_file", { path: "preise.js", old_text: "1.077", new_text: "1.081" })
		expect(r.ok).toBe(true)
		// Der Rest der Datei muss unangetastet sein — das ist der ganze Zweck.
		expect(fs.readFileSync(path.join(dir, "preise.js"), "utf8")).toBe(
			"const mwst = 1.081\nconst rabatt = 0.1\n",
		)
	})

	it("verweigert eine mehrdeutige Ersetzung und sagt, wie viele Stellen es sind", async () => {
		fs.writeFileSync(path.join(dir, "doppelt.js"), "const a = 1\nconst a = 1\n")
		const r = await run("edit_file", { path: "doppelt.js", old_text: "const a = 1", new_text: "const b = 2" })
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("2-mal")
		// Nichts geändert — eine geratene Stelle wäre schlimmer als ein Fehler.
		expect(fs.readFileSync(path.join(dir, "doppelt.js"), "utf8")).toBe("const a = 1\nconst a = 1\n")
	})

	it("ersetzt auf Wunsch alle Vorkommen", async () => {
		const r = await run("edit_file", {
			path: "doppelt.js",
			old_text: "const a = 1",
			new_text: "const b = 2",
			replace_all: true,
		})
		expect(r.ok).toBe(true)
		expect(fs.readFileSync(path.join(dir, "doppelt.js"), "utf8")).toBe("const b = 2\nconst b = 2\n")
	})

	it("erklärt einen nicht gefundenen Text mit dem häufigsten Grund", async () => {
		const r = await run("edit_file", { path: "preise.js", old_text: "gibt es nicht", new_text: "x" })
		expect(r.ok).toBe(false)
		// Statt „muss exakt übereinstimmen“ steht jetzt da, was wirklich dasteht.
		expect(r.detail).toMatch(/gibt es dort nicht|kopiere sie/)
	})

	it("hängt an, legt an, kopiert, verschiebt und löscht", async () => {
		expect((await run("append_file", { path: "log.txt", content: "eins\n" })).ok).toBe(true)
		expect((await run("append_file", { path: "log.txt", content: "zwei\n" })).ok).toBe(true)
		expect(fs.readFileSync(path.join(dir, "log.txt"), "utf8")).toBe("eins\nzwei\n")

		expect((await run("make_dir", { path: "unter/tief" })).ok).toBe(true)
		expect(fs.statSync(path.join(dir, "unter/tief")).isDirectory()).toBe(true)

		expect((await run("copy_file", { from: "log.txt", to: "unter/tief/log.txt" })).ok).toBe(true)
		expect(fs.existsSync(path.join(dir, "unter/tief/log.txt"))).toBe(true)

		expect((await run("move_file", { from: "unter/tief/log.txt", to: "unter/neu.txt" })).ok).toBe(true)
		expect(fs.existsSync(path.join(dir, "unter/tief/log.txt"))).toBe(false)
		expect(fs.existsSync(path.join(dir, "unter/neu.txt"))).toBe(true)

		expect((await run("delete_file", { path: "unter/neu.txt" })).ok).toBe(true)
		expect(fs.existsSync(path.join(dir, "unter/neu.txt"))).toBe(false)
	})

	it("überschreibt ein vorhandenes Ziel nicht ungefragt", async () => {
		fs.writeFileSync(path.join(dir, "ziel.txt"), "wichtig")
		const r = await run("copy_file", { from: "log.txt", to: "ziel.txt" })
		expect(r.ok).toBe(false)
		expect(fs.readFileSync(path.join(dir, "ziel.txt"), "utf8")).toBe("wichtig")
		expect((await run("copy_file", { from: "log.txt", to: "ziel.txt", overwrite: true })).ok).toBe(true)
	})

	it("löscht ein volles Verzeichnis nur auf ausdrückliche Ansage", async () => {
		fs.mkdirSync(path.join(dir, "voll"), { recursive: true })
		fs.writeFileSync(path.join(dir, "voll/x.txt"), "x")
		const r = await run("delete_file", { path: "voll" })
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("recursive")
		expect((await run("delete_file", { path: "voll", recursive: true })).ok).toBe(true)
		expect(fs.existsSync(path.join(dir, "voll"))).toBe(false)
	})

	it("bleibt auch beim Verschieben in der Sandbox", async () => {
		const r = await run("move_file", { from: "log.txt", to: "../entwischt.txt" })
		expect(r.ok).toBe(false)
		expect(fs.existsSync(path.join(dir, "..", "entwischt.txt"))).toBe(false)
	})

	it("findet eine Stelle mit Pfad und Zeilennummer", async () => {
		fs.mkdirSync(path.join(dir, "src"), { recursive: true })
		fs.writeFileSync(path.join(dir, "src/a.js"), "// oben\nconst sku = 'ABC'\n")
		const r = await run("search_files", { query: "sku" })
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("src/a.js:2:")
	})

	it("meldet eine leere Suche als Ergebnis, nicht als Fehler", async () => {
		const r = await run("search_files", { query: "kommtnichtvor" })
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("Keine Treffer")
	})

	it("überspringt node_modules beim Auflisten und Suchen", async () => {
		fs.mkdirSync(path.join(dir, "node_modules/paket"), { recursive: true })
		fs.writeFileSync(path.join(dir, "node_modules/paket/index.js"), "const sku = 1")
		const liste = await run("list_files", {})
		expect(liste.detail).not.toContain("node_modules")
		const suche = await run("search_files", { query: "sku" })
		expect(suche.detail).not.toContain("node_modules")
	})

	it("liest eine grosse Datei abschnittsweise mit Zeilennummern", async () => {
		fs.writeFileSync(
			path.join(dir, "lang.txt"),
			Array.from({ length: 500 }, (_, i) => `Zeile ${i + 1}`).join("\n"),
		)
		const r = await run("read_file", { path: "lang.txt", start_line: 100, max_lines: 3 })
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("100: Zeile 100")
		expect(r.detail).toContain("102: Zeile 102")
		expect(r.detail).not.toContain("103: Zeile 103")
	})

	it("sagt, was ein Pfad ist, ohne ihn zu lesen", async () => {
		const r = await run("file_info", { path: "lang.txt" })
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("Datei")
		expect(r.detail).toContain("500 Zeilen")
		expect((await run("file_info", { path: "gibtsnicht.txt" })).detail).toContain("existiert nicht")
	})
})

describe("tools: Schreibweisen, die Modelle wirklich schicken", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-formen-"))
	const run = (name: string, args: Record<string, unknown>) => executeTool(dir, call(name, args), emitOp, log)

	it("normalisiert Pfade, statt sie abzuweisen", () => {
		// Jede dieser Formen ist im Log als roter Fehlschlag aufgetaucht.
		expect(normalisierePfad(".")).toBe("")
		expect(normalisierePfad("./")).toBe("")
		expect(normalisierePfad("./src/a.js")).toBe("src/a.js")
		expect(normalisierePfad("/src/a.js")).toBe("src/a.js")
		expect(normalisierePfad("src/")).toBe("src")
		expect(normalisierePfad("src//a.js")).toBe("src/a.js")
		expect(normalisierePfad("src\\a.js")).toBe("src/a.js")
		expect(normalisierePfad("src/./a.js")).toBe("src/a.js")
		// `..` bleibt `..` — der Ausbruchsversuch wird benannt, nicht geglättet.
		expect(normalisierePfad("../geheim")).toBe("../geheim")
	})

	it('sucht mit `path: "."` — der Fall aus dem echten Lauf', async () => {
		fs.mkdirSync(path.join(dir, "src"), { recursive: true })
		fs.writeFileSync(path.join(dir, "src/a.js"), "const sku = 1\n")
		const r = await run("search_files", { query: "sku", path: "." })
		expect(r.ok).toBe(true)
		expect(r.detail).toContain("src/a.js:1:")
	})

	it("liest eine Datei auch mit führendem Schrägstrich oder Punkt", async () => {
		for (const form of ["/src/a.js", "./src/a.js", "src\\a.js".replace("a.js", "a.js")]) {
			const r = await run("read_file", { path: form })
			expect(r.ok, `Form „${form}" wurde abgewiesen: ${r.detail}`).toBe(true)
		}
	})

	it("versteht die Argumentnamen anderer Werkzeugsätze", async () => {
		// `old_string`/`new_string` statt `old_text`/`new_text` — verbreitete
		// Schreibweise, auf die viele Modelle trainiert sind.
		const r = await run("edit_file", { file: "src/a.js", old_string: "1", new_string: "2" })
		expect(r.ok, r.detail).toBe(true)
		expect(fs.readFileSync(path.join(dir, "src/a.js"), "utf8")).toBe("const sku = 2\n")

		// `pattern` statt `query`
		expect((await run("search_files", { pattern: "sku" })).detail).toContain("src/a.js")

		// `source`/`destination` statt `from`/`to`
		const m = await run("copy_file", { source: "src/a.js", destination: "src/b.js" })
		expect(m.ok, m.detail).toBe(true)

		// `text` statt `content`
		const w = await run("write_file", { path: "notiz.txt", text: "hallo" })
		expect(w.ok, w.detail).toBe(true)
		expect(fs.readFileSync(path.join(dir, "notiz.txt"), "utf8")).toBe("hallo")
	})

	it('nimmt `"true"` als Ja — ein Modell, das sich entschieden hat', async () => {
		fs.writeFileSync(path.join(dir, "viel.txt"), "x\nx\n")
		const r = await run("edit_file", {
			path: "viel.txt",
			old_text: "x",
			new_text: "y",
			replace_all: "true",
		})
		expect(r.ok, r.detail).toBe(true)
		expect(fs.readFileSync(path.join(dir, "viel.txt"), "utf8")).toBe("y\ny\n")

		fs.mkdirSync(path.join(dir, "weg"), { recursive: true })
		fs.writeFileSync(path.join(dir, "weg/x.txt"), "x")
		expect((await run("delete_file", { path: "weg", recursive: "yes" })).ok).toBe(true)
	})

	it("nimmt Zeilenangaben auch als Text", async () => {
		fs.writeFileSync(path.join(dir, "z.txt"), "eins\nzwei\ndrei\n")
		const r = await run("read_file", { path: "z.txt", start_line: "2", max_lines: "1" })
		expect(r.ok, r.detail).toBe(true)
		expect(r.detail).toContain("2: zwei")
		expect(r.detail).not.toContain("drei")
	})

	it("lässt einen Ausbruch weiterhin nicht durchgehen", async () => {
		for (const böse of ["../entwischt.txt", "/../../etc/passwd", "src/../../weg.txt"]) {
			const r = await run("write_file", { path: böse, content: "x" })
			expect(r.ok, `„${böse}" wurde durchgelassen!`).toBe(false)
		}
		expect(fs.existsSync(path.join(dir, "..", "entwischt.txt"))).toBe(false)
	})
})

describe("tools: derselbe Pfad überall", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-pfadgleich-"))
	const run = (name: string, args: Record<string, unknown>) => executeTool(dir, call(name, args), emitOp, log)

	it("führt aus, was write_file angenommen hat", async () => {
		// Der Lauf, der 39 Operationen kostete: `write_file("/tmp/fix.js")` wurde
		// angenommen, `node /tmp/fix.js` abgewiesen. Zwei Auffassungen desselben
		// Pfades sind keine Sicherheit, sondern eine Falle.
		const w = await run("write_file", { path: "/tmp/fix.js", content: "console.log('läuft')" })
		expect(w.ok, w.detail).toBe(true)
		const r = await run("run_command", { command: "node /tmp/fix.js" })
		expect(r.ok, r.detail).toBe(true)
		expect(r.detail).toContain("läuft")
	})

	it("lässt einen echten Ausbruch weiterhin nicht zu", async () => {
		const r = await run("run_command", { command: "cat ../../../etc/passwd" })
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("aus dem Workspace heraus")
	})
})

describe("tools: edit_file zeigt, was wirklich dasteht", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-editfehler-"))
	const run = (name: string, args: Record<string, unknown>) => executeTool(dir, call(name, args), emitOp, log)

	it("zeigt den Ist-Zustand mit sichtbarer Einrückung, wenn die Stelle mehrdeutig ist", async () => {
		// Zweimal derselbe Rumpf, verschieden eingerückt: Hier darf DiriZ nicht
		// raten — es zeigt, was dasteht, und lässt das Modell entscheiden.
		fs.writeFileSync(
			path.join(dir, "a.js"),
			"function f() {\n\treturn v.trim()\n}\n\nfunction g() {\n  return v.trim()\n}\n",
		)
		const r = await run("edit_file", {
			path: "a.js",
			old_text: "        return v.trim()",
			new_text: "        return v.trim().toUpperCase()",
		})
		expect(r.ok).toBe(false)
		// Der Tabulator wird sichtbar gemacht — sonst sieht man den Unterschied nicht.
		expect(r.detail).toContain("→return v.trim()")
	})

	it("übernimmt eine eindeutige Stelle trotz abweichender Einrückung", async () => {
		fs.writeFileSync(path.join(dir, "eindeutig.js"), "function clean(v) {\n\treturn v.trim()\n}\n")
		const r = await run("edit_file", {
			path: "eindeutig.js",
			old_text: "    return v.trim()",
			new_text: "\treturn v.trim().toUpperCase()",
		})
		expect(r.ok, r.detail).toBe(true)
		expect(fs.readFileSync(path.join(dir, "eindeutig.js"), "utf8")).toContain("toUpperCase")
	})

	it("sagt es klar, wenn die Stelle wirklich fehlt", async () => {
		const r = await run("edit_file", { path: "a.js", old_text: "gibtesnichtimtext", new_text: "x" })
		expect(r.ok).toBe(false)
		expect(r.detail).toContain("gibt es dort nicht")
	})
})

describe("tools: edit_file verzeiht, was Modelle beim JSON tun", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-editrepair-"))
	const run = (name: string, args: Record<string, unknown>) => executeTool(dir, call(name, args), emitOp, log)

	it("begradigt doppelte Backslashes — der Fall aus dem echten Lauf", async () => {
		fs.writeFileSync(path.join(dir, "render.js"), "const c = String(v).replace(/\\s+/g, ' ').trim()\n")
		// Genau das schickte nvidia-nemotron: `\\s` statt `\s`.
		const r = await run("edit_file", {
			path: "render.js",
			old_text: "String(v).replace(/\\\\s+/g, ' ')",
			new_text: "String(v).replace(/[^a-zA-Z0-9_-]/g, '')",
		})
		expect(r.ok, r.detail).toBe(true)
		expect(r.detail).toContain("Backslashes")
		expect(fs.readFileSync(path.join(dir, "render.js"), "utf8")).toBe(
			"const c = String(v).replace(/[^a-zA-Z0-9_-]/g, '').trim()\n",
		)
	})

	it("findet den Block auch bei abweichender Einrückung — wenn er eindeutig ist", async () => {
		fs.writeFileSync(path.join(dir, "b.js"), "function f() {\n\treturn 1\n}\n")
		const r = await run("edit_file", {
			path: "b.js",
			old_text: "function f() {\n    return 1\n}",
			new_text: "function f() {\n\treturn 2\n}",
		})
		expect(r.ok, r.detail).toBe(true)
		expect(r.detail).toContain("Einrückung")
		expect(fs.readFileSync(path.join(dir, "b.js"), "utf8")).toBe("function f() {\n\treturn 2\n}\n")
	})

	it("rät nicht, wenn es mehrdeutig ist", async () => {
		fs.writeFileSync(path.join(dir, "c.js"), "  const a = 1\n\tconst a = 1\n")
		const r = await run("edit_file", { path: "c.js", old_text: "const a = 1", new_text: "const a = 2" })
		expect(r.ok).toBe(false)
		// Unverändert — eine geratene Stelle fiele niemandem auf.
		expect(fs.readFileSync(path.join(dir, "c.js"), "utf8")).toBe("  const a = 1\n\tconst a = 1\n")
	})
})
