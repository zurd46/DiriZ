/**
 * Sandbox-Tests für die Werkzeuge (list/read/write/run).
 * Fokus: Pfad-Sicherheit (Traversal), korrekte Ergebnisse — und beim
 * Ausführen von Befehlen vor allem das, was **nicht** gehen darf.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolCallRequest } from "@diriz/shared"
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
import { executeTool, TOOL_SPECS } from "../src/execution/tools.js"

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
	it("definiert genau die vier Werkzeuge mit JSON-Schemas", async () => {
		expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual([
			"list_files",
			"read_file",
			"run_command",
			"write_file",
		])
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

	it("kennt keine Shell: Sonderzeichen bleiben Zeichen", async () => {
		// Ohne Shell ist das ein Argument für `node -e`, keine Befehlskette.
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
		expect(r.ok).toBe(true)
		expect(fs.existsSync(opfer)).toBe(true)
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
		for (const arg of ["/etc/passwd", "~/.ssh/id_rsa", "../../geheim.txt"]) {
			const r = await executeTool(runDir, call("run_command", { command: "node", args: [arg] }), emitOp, log)
			expect(r.ok, arg).toBe(false)
			expect(r.detail, arg).toContain("Workspace")
		}
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
