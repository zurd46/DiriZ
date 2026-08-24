/**
 * M8 Agentik: Sandbox-Tests für die Datei-Tools (list/read/write).
 * Fokus: Pfad-Sicherheit (Traversal) + korrekte Ergebnisse.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolCallRequest } from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { appendToolCall, createTask, listToolCallsByTask } from "../src/db/repositories.js"
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
	it("definiert genau die drei Tools mit JSON-Schemas", () => {
		expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(["list_files", "read_file", "write_file"])
		for (const spec of TOOL_SPECS) {
			expect(spec.parameters.type).toBe("object")
			expect(spec.description.length).toBeGreaterThan(0)
		}
	})

	it("schreibt und liest Dateien in der Sandbox", () => {
		const w = executeTool(
			baseDir,
			call("write_file", { path: "src/hello.txt", content: "hallo diriz" }),
			emitOp,
			log,
		)
		expect(w.ok).toBe(true)
		expect(fs.readFileSync(path.join(baseDir, "src/hello.txt"), "utf8")).toBe("hallo diriz")

		const r = executeTool(baseDir, call("read_file", { path: "src/hello.txt" }), emitOp, log)
		expect(r.ok).toBe(true)
		expect(r.detail).toBe("hallo diriz")
	})

	it("listet Dateien rekursiv (sortiert)", () => {
		executeTool(baseDir, call("write_file", { path: "a/b.txt", content: "x" }), emitOp, log)
		const r = executeTool(baseDir, call("list_files", {}), emitOp, log)
		expect(r.ok).toBe(true)
		const lines = r.detail.split("\n")
		expect(lines).toContain("src/hello.txt")
		expect(lines).toContain("a/b.txt")
	})

	it("blockt Pfad-Traversals beim Lesen", () => {
		for (const p of ["../../etc/passwd", "/etc/passwd", "..\\evil"]) {
			const r = executeTool(baseDir, call("read_file", { path: p }), emitOp, log)
			expect(r.ok).toBe(false)
		}
	})

	it("blockt Pfad-Traversals beim Schreiben (Datei bleibt in der Sandbox)", () => {
		const escapedPath = path.join(os.tmpdir(), `diriz-escape-${Date.now()}.txt`)
		const r = executeTool(
			baseDir,
			call("write_file", { path: `../../${path.basename(escapedPath)}`, content: "x" }),
			emitOp,
			log,
		)
		expect(r.ok).toBe(false)
		expect(fs.existsSync(escapedPath)).toBe(false)
	})

	it("meldet fehlende Dateien und unbekannte Tools als Fehler (kein Wurf)", () => {
		const missing = executeTool(baseDir, call("read_file", { path: "keine/datei.txt" }), emitOp, log)
		expect(missing.ok).toBe(false)
		expect(missing.detail).toContain("nicht gefunden")

		const unknown = executeTool(baseDir, call("delete_everything", {}), emitOp, log)
		expect(unknown.ok).toBe(false)
	})

	it("emittiert jede Operation (Transparenz)", () => {
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
	it("speichert sie in Reihenfolge und liefert sie zur Task", () => {
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
