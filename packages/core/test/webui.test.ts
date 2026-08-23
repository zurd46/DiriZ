/**
 * Tests für den Betrieb als **eine** Anwendung: Der Core liefert die gebaute
 * Oberfläche aus, beantwortet Deep-Links mit dem SPA-Fallback und gibt für
 * unbekannte API-Pfade sauberes JSON statt HTML zurück. Dazu die
 * Versions-Auskunft, an der man einen veralteten Prozess erkennt.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppContext } from "../src/app.js"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { findWebDir } from "../src/routes/webui.js"
import { Feedback } from "../src/routing/feedback.js"

const MARKER = "<!-- diriz-test-ui -->"

let db: Db
let app: FastifyInstance
let webDir: string
let previousWebDir: string | undefined

async function buildTestApp(): Promise<FastifyInstance> {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-webui-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-webui-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	const bus = new EventBus()
	const feedback = new Feedback()
	const log = () => {}
	const registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		() => undefined,
	)
	const engine = new ExecutionEngine({
		db,
		registry,
		feedback,
		emit: (e) => bus.emit(e),
		log,
		workspaceDir,
	})
	const ctx: AppContext = {
		db,
		bus,
		registry,
		engine,
		feedback,
		secret: Buffer.from("test-secret-0123456789abcdef0123456789abcdef"),
		workspaceDir,
		reposDir: fs.mkdtempSync(path.join(os.tmpdir(), "diriz-repos-")),
	}
	return buildApp(ctx)
}

beforeAll(async () => {
	// Eigenes „gebautes“ UI, damit der Test nicht davon abhängt, ob im Repo
	// gerade ein Vite-Build liegt.
	webDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-webdist-"))
	fs.writeFileSync(path.join(webDir, "index.html"), `<!doctype html><title>DiriZ</title>${MARKER}`)
	fs.mkdirSync(path.join(webDir, "assets"))
	fs.writeFileSync(path.join(webDir, "assets", "app-abc123.js"), "console.log('diriz')")
	previousWebDir = process.env.DIRIZ_WEB_DIR
	process.env.DIRIZ_WEB_DIR = webDir
	app = await buildTestApp()
})

afterAll(async () => {
	await app.close().catch(() => {})
	db.close()
	if (previousWebDir === undefined) {
		delete process.env.DIRIZ_WEB_DIR
	} else {
		process.env.DIRIZ_WEB_DIR = previousWebDir
	}
})

describe("Versions-Auskunft", () => {
	it("nennt Version, Schema-Stand und Laufzeit", async () => {
		const res = await app.inject({ method: "GET", url: "/api/version" })
		expect(res.statusCode).toBe(200)
		const body = res.json() as { name: string; version: string; schemaVersion: number; uptimeSec: number }
		expect(body.name).toBe("DiriZ")
		expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
		expect(body.schemaVersion).toBeGreaterThan(0)
		expect(body.uptimeSec).toBeGreaterThanOrEqual(0)
	})
})

describe("Auslieferung der Oberfläche", () => {
	it("liefert index.html an der Wurzel", async () => {
		const res = await app.inject({ method: "GET", url: "/" })
		expect(res.statusCode).toBe(200)
		expect(res.body).toContain(MARKER)
	})

	it("beantwortet Deep-Links mit dem SPA-Fallback", async () => {
		for (const url of ["/tasks", "/docs", "/settings"]) {
			const res = await app.inject({ method: "GET", url })
			expect(res.statusCode, url).toBe(200)
			expect(res.body, url).toContain(MARKER)
		}
	})

	it("cacht gehashte Assets dauerhaft, index.html nie", async () => {
		const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" })
		expect(asset.statusCode).toBe(200)
		expect(asset.headers["cache-control"]).toContain("immutable")

		const html = await app.inject({ method: "GET", url: "/" })
		expect(html.headers["cache-control"]).toBe("no-cache")
	})

	it("gibt für unbekannte API-Pfade JSON zurück, nicht die Oberfläche", async () => {
		const res = await app.inject({ method: "GET", url: "/api/gibt-es-nicht" })
		expect(res.statusCode).toBe(404)
		expect(res.headers["content-type"]).toContain("application/json")
		expect((res.json() as { error: string }).error).toContain("/api/gibt-es-nicht")
	})

	it("liefert kein HTML für schreibende Anfragen ins Leere", async () => {
		const res = await app.inject({ method: "POST", url: "/existiert-nicht", payload: {} })
		expect(res.statusCode).toBe(404)
		expect(res.body).not.toContain(MARKER)
	})
})

describe("Suche nach dem UI-Build", () => {
	it("nimmt DIRIZ_WEB_DIR, wenn dort ein index.html liegt", () => {
		expect(findWebDir({ DIRIZ_WEB_DIR: webDir })).toBe(webDir)
	})

	it("meldet nichts, wenn das Verzeichnis kein index.html enthält", () => {
		const leer = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-leer-"))
		expect(findWebDir({ DIRIZ_WEB_DIR: leer })).toBeUndefined()
	})
})
