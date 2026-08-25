import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RoutingDecision } from "@diriz/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	appendChunk,
	clearLoadFailures,
	createExecution,
	createProvider,
	createTask,
	createTemplate,
	deleteProvider,
	deleteTemplate,
	getFileContent,
	getTask,
	getTemplate,
	istDieselbeMaschine,
	latestDecision,
	listFileHistory,
	listFilesByTask,
	listInstances,
	listLogRows,
	listProviders,
	listTasks,
	listTemplates,
	metricsSummary,
	persistLog,
	recordLoadFailure,
	replayOutput,
	saveDecision,
	saveFile,
	setInstanceStatus,
	setProviderStatus,
	setTaskStatus,
	timeseries,
	unlockInstance,
	updateExecution,
	updateInstance,
	updateProvider,
	updateTemplate,
	upsertInstance,
	workspaceFiles,
} from "../src/db/repositories.js"

let db: Db

beforeAll(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-test-"))
	db = openDatabase(dir)
	migrate(db)
})

afterAll(() => {
	db.close()
})

describe("db: Migrations", () => {
	it("erzeugt alle Tabellen", () => {
		const tables = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
				name: string
			}[]
		).map((t) => t.name)
		for (const expected of [
			"providers",
			"instances",
			"tasks",
			"executions",
			"execution_chunks",
			"routing_decisions",
			"files",
			"metrics_hourly",
			"logs",
			"settings",
		]) {
			expect(tables).toContain(expected)
		}
	})
})

describe("db: Provider CRUD", () => {
	it("legt, listet, ändert und löscht Provider", () => {
		const p = createProvider(db, { type: "ollama", label: "Ollama Test", baseUrl: "http://localhost:11434" })
		expect(p.id).toBeTruthy()
		expect(p.hasApiKey).toBe(false)
		expect(listProviders(db).length).toBeGreaterThanOrEqual(1)

		const updated = updateProvider(db, p.id, { label: "Ollama Neu", enabled: false })
		expect(updated?.label).toBe("Ollama Neu")
		expect(updated?.enabled).toBe(false)

		setProviderStatus(db, p.id, "online", 12, 34)
		expect(listProviders(db).find((x) => x.id === p.id)?.latencyP50).toBe(12)

		expect(deleteProvider(db, p.id)).toBe(true)
		expect(listProviders(db).find((x) => x.id === p.id)).toBeUndefined()
	})
})

describe("db: Instances", () => {
	it("upsertet Modelle (neues + bestehendes)", () => {
		const p = createProvider(db, { type: "lmstudio", label: "LMS", baseUrl: "http://localhost:1234/v1" })
		const a = upsertInstance(
			db,
			p.id,
			{ modelId: "qwen", displayName: "Qwen", contextWindow: 4096 },
			"manual",
		)
		expect(a.id).toBeTruthy()
		const b = upsertInstance(
			db,
			p.id,
			{ modelId: "qwen", displayName: "Qwen 3", contextWindow: 8192 },
			"discovered",
		)
		expect(b.id).toBe(a.id)
		const listed = listInstances(db, p.id)
		expect(listed.length).toBe(1)
		expect(listed[0]?.displayName).toBe("Qwen 3")

		setInstanceStatus(db, a.id, "online")
		expect(listInstances(db, p.id)[0]?.status).toBe("online")
		deleteProvider(db, p.id)
	})

	it("schaltet Modelle pro Rechner an/aus (enabled-Flag)", () => {
		const p = createProvider(db, { type: "ollama", label: "Oll", baseUrl: "http://localhost:11434" })
		const a = upsertInstance(db, p.id, { modelId: "m-a", displayName: "A" }, "discovered")
		upsertInstance(db, p.id, { modelId: "m-b", displayName: "B" }, "discovered")
		expect(a.enabled).toBe(true) // Default: aktiv

		const before = metricsSummary(db, 0).instances
		const off = updateInstance(db, a.id, { enabled: false })
		expect(off?.enabled).toBe(false)
		expect(listInstances(db, p.id).filter((i) => i.enabled)).toHaveLength(1)
		expect(metricsSummary(db, 0).instances).toBe(before - 1)

		const on = updateInstance(db, a.id, { enabled: true })
		expect(on?.enabled).toBe(true)
		expect(metricsSummary(db, 0).instances).toBe(before)
		deleteProvider(db, p.id)
	})
})

describe("db: Tasks & Executions", () => {
	it("rundet Task → Execution → Chunks → Replay durch", () => {
		const task = createTask(db, {
			prompt: "Schreib mir eine Funktion",
			metadata: { privacy: "local-only", mode: "auto", goal: "Python-Funktion" },
		})
		expect(task.status).toBe("draft")
		expect(task.metadata.privacy).toBe("local-only")

		setTaskStatus(db, task.id, "running")
		expect(getTask(db, task.id)?.status).toBe("running")

		const exec = createExecution(db, { taskId: task.id, failoverCount: 0 })
		expect(exec.status).toBe("pending")

		appendChunk(db, exec.id, 0, "Hallo ")
		appendChunk(db, exec.id, 1, "Welt")
		expect(replayOutput(db, exec.id)).toBe("Hallo Welt")

		updateExecution(db, exec.id, { status: "done", tokensIn: 10, tokensOut: 5, output: "Hallo Welt" })
		const got = db.prepare("SELECT * FROM executions WHERE id = ?").get(exec.id) as { tokens_out: number }
		expect(got.tokens_out).toBe(5)

		expect(listTasks(db).some((t) => t.id === task.id)).toBe(true)

		// Aufräumen
		db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
	})
})

describe("db: Dateien", () => {
	it("speichert, listet und holt Inhalte (neuster Stand pro Pfad)", () => {
		const task = createTask(db, { prompt: "Files" })
		const exec = createExecution(db, { taskId: task.id })
		saveFile(db, { executionId: exec.id, taskId: task.id, relPath: "src/a.py", size: 3, content: "v1" })
		saveFile(db, { executionId: exec.id, taskId: task.id, relPath: "src/a.py", size: 4, content: "v11" })
		saveFile(db, { executionId: exec.id, taskId: task.id, relPath: "src/b.py", size: 1, content: "b" })

		const files = listFilesByTask(db, task.id)
		expect(files.length).toBe(2)
		const a = files.find((f) => f.relPath === "src/a.py")
		expect(a?.size).toBe(4)
		expect(getFileContent(db, exec.id, "src/a.py")).toBe("v11")
		expect(workspaceFiles(db).some((f) => f.relPath === "src/b.py")).toBe(true)

		db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
	})

	it("liefert die Datei-Historie (neueste zuerst) und Herkunft im Workspace-Baum", () => {
		const task = createTask(db, { prompt: "History" })
		const exec1 = createExecution(db, { taskId: task.id })
		const exec2 = createExecution(db, { taskId: task.id })
		saveFile(db, { executionId: exec1.id, taskId: task.id, relPath: "src/h.py", size: 2, content: "alt" })
		saveFile(db, { executionId: exec2.id, taskId: task.id, relPath: "src/h.py", size: 5, content: "neuer" })

		const history = listFileHistory(db, "src/h.py")
		expect(history).toHaveLength(2)
		expect(history[0]?.executionId).toBe(exec2.id)
		expect(history[1]?.executionId).toBe(exec1.id)

		const latest = workspaceFiles(db).find((f) => f.relPath === "src/h.py")
		expect(latest?.executionId).toBe(exec2.id)
		expect(latest?.taskId).toBe(task.id)

		db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
	})
})

describe("db: Routing-Entscheidung", () => {
	it("persistiert die Explainability-Basis", () => {
		const task = createTask(db, { prompt: "Routing" })
		const exec = createExecution(db, { taskId: task.id })
		const decision: RoutingDecision = {
			executionId: exec.id,
			chosenInstanceId: "inst-1",
			candidates: [{ instanceId: "inst-1", providerId: "p", modelId: "m", score: 82.5, axes: [] }],
			excluded: [{ instanceId: "x", providerId: "p", modelId: "m2", reason: "offline" }],
			profile: {
				estTokens: 1000,
				requiredCapabilities: ["code"],
				preferredCapabilities: [],
				privacy: "local-only",
				mode: "auto",
			},
			weights: {
				contextFit: 0.3,
				capabilityMatch: 0.3,
				qualityPrior: 0.2,
				loadScore: 0.08,
				costScore: 0.07,
				latencyScore: 0.05,
			},
			createdAt: new Date().toISOString(),
		}
		saveDecision(db, decision)
		const got = latestDecision(db, exec.id)
		expect(got?.chosenInstanceId).toBe("inst-1")
		expect(got?.excluded[0]?.reason).toBe("offline")
		expect(got?.profile.estTokens).toBe(1000)

		db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
	})
})

describe("db: Logs & Metriken", () => {
	it("persistiert Logs mit Filterung", () => {
		persistLog(db, { ts: new Date().toISOString(), level: "info", scope: "test", msg: "hallo" })
		persistLog(db, { ts: new Date().toISOString(), level: "error", scope: "other", msg: "fehler" })
		const infos = listLogRows(db, { level: "info" })
		expect(infos.some((l) => l.msg === "hallo")).toBe(true)
		expect(infos.every((l) => l.level === "info")).toBe(true)
		const scoped = listLogRows(db, { scope: "other" })
		expect(scoped.every((l) => l.scope === "other")).toBe(true)
	})

	it("rechnet Metriken-Summary + Time-Series", () => {
		const task = createTask(db, { prompt: "Metrik" })
		const exec = createExecution(db, { taskId: task.id })
		updateExecution(db, exec.id, {
			status: "done",
			tokensIn: 100,
			tokensOut: 50,
			costUsd: 0.01,
			finishedAt: new Date().toISOString(),
		})
		const summary = metricsSummary(db, 0)
		expect(summary.tasks).toBeGreaterThanOrEqual(1)
		expect(summary.executions).toBeGreaterThanOrEqual(1)
		expect(summary.tokensIn24h).toBeGreaterThanOrEqual(100)
		expect(summary.costUsd24h).toBeGreaterThanOrEqual(0.01)

		const points = timeseries(db, 24)
		expect(points.length).toBe(1)
		expect(points[0]?.requests).toBe(1)

		db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
	})
})

describe("db: Prompt-Templates", () => {
	it("seedet Standard-Vorlagen und erlaubt CRUD", () => {
		const seeded = listTemplates(db)
		expect(seeded.some((t) => t.name === "Senior-Dev")).toBe(true)
		expect(seeded.some((t) => t.name === "Kritischer Reviewer")).toBe(true)

		const tpl = createTemplate(db, { name: "Test-Vorlage", prompt: "Sei präzise." })
		expect(getTemplate(db, tpl.id)?.name).toBe("Test-Vorlage")

		const renamed = updateTemplate(db, tpl.id, { name: "Umbenannt" })
		expect(renamed?.name).toBe("Umbenannt")
		expect(renamed?.prompt).toBe("Sei präzise.")

		const edited = updateTemplate(db, tpl.id, { prompt: "Neuer Text." })
		expect(edited?.prompt).toBe("Neuer Text.")

		expect(deleteTemplate(db, tpl.id)).toBe(true)
		expect(listTemplates(db).some((t) => t.id === tpl.id)).toBe(false)
	})

	it("verweigert doppelte Namen und unbekannte IDs", () => {
		const dup = createTemplate(db, { name: "Duplikat", prompt: "x" })
		expect(() => createTemplate(db, { name: "Duplikat", prompt: "y" })).toThrow()

		expect(updateTemplate(db, "keine-id", { name: "Neu" })).toBeUndefined()
		expect(deleteTemplate(db, "keine-id")).toBe(false)

		deleteTemplate(db, dup.id)
	})
})

describe("Ladefehler-Zähler", () => {
	it("zählt hoch, und ein erfolgreicher Lauf löscht ihn", () => {
		const p = createProvider(db, { type: "lmstudio", label: "Zaehler", baseUrl: "http://z" })
		const inst = upsertInstance(
			db,
			p.id,
			{ modelId: "zu-gross", displayName: "Zu gross", contextWindow: 8192, capabilities: ["code"] },
			"manual",
		)
		expect(recordLoadFailure(db, inst.id)).toBe(1)
		expect(recordLoadFailure(db, inst.id)).toBe(2)
		// Ein gelungener Lauf löscht die Vorgeschichte — sonst wüchse die Sperre
		// eines Modells, das längst wieder läuft, bis auf 24 Stunden.
		clearLoadFailures(db, inst.id)
		expect(recordLoadFailure(db, inst.id)).toBe(1)
	})

	it("löscht den Zähler auch beim Entsperren", () => {
		const p = createProvider(db, { type: "lmstudio", label: "Zaehler2", baseUrl: "http://z2" })
		const inst = upsertInstance(
			db,
			p.id,
			{ modelId: "m", displayName: "M", contextWindow: 8192, capabilities: ["code"] },
			"manual",
		)
		recordLoadFailure(db, inst.id)
		recordLoadFailure(db, inst.id)
		unlockInstance(db, inst.id)
		expect(recordLoadFailure(db, inst.id)).toBe(1)
	})
})

describe("Derselbe Rechner, zwei Zugänge", () => {
	it("erkennt Tunnel und Direktzugang trotz einer abweichenden Modellkopie", () => {
		// Der echte Fall: `lokalai` (ngrok) führte `…-uncensored:2` zusätzlich —
		// LM Studios Zweitkopie desselben Modells. Ein Eintrag Unterschied, und
		// DiriZ sah zwei Grafikkarten, wo eine steht.
		const direkt = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"])
		const tunnel = new Set([...direkt, "n:2"])
		expect(istDieselbeMaschine(direkt, tunnel)).toBe(true)
		expect(istDieselbeMaschine(tunnel, direkt)).toBe(true)
	})

	it("hält wirklich verschiedene Rechner auseinander", () => {
		const macbook = new Set(["qwen3", "llama3", "mistral", "phi4", "gemma"])
		const server = new Set(["deepseek-v4", "kimi", "glm", "minimax", "qwen3"])
		expect(istDieselbeMaschine(macbook, server)).toBe(false)
	})

	it("erklärt zwei kleine, ungleiche Listen nicht vorschnell für denselben Rechner", () => {
		// Deckungsgleich zählt immer — das ist der alte, enge Massstab.
		expect(istDieselbeMaschine(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(true)
		// Aber bei zwei Modellen reicht „fast gleich" nicht: zu wenig Substanz.
		expect(istDieselbeMaschine(new Set(["a", "b"]), new Set(["a", "b", "c"]))).toBe(false)
	})
})
