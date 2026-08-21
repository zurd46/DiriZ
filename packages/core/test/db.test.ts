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
	createExecution,
	createProvider,
	createTask,
	deleteProvider,
	getFileContent,
	getTask,
	latestDecision,
	listFilesByTask,
	listInstances,
	listLogRows,
	listProviders,
	listTasks,
	metricsSummary,
	persistLog,
	replayOutput,
	saveDecision,
	saveFile,
	setInstanceStatus,
	setProviderStatus,
	setTaskStatus,
	timeseries,
	updateExecution,
	updateProvider,
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
