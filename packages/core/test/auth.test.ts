/**
 * Anmeldung: Türsteher, Sitzungen, Benutzerverwaltung.
 *
 * Sicherheitsrelevant, deshalb wird hier nicht nur der glückliche Pfad geprüft,
 * sondern vor allem, was **nicht** gehen darf: ohne Sitzung hinein, ein zweites
 * Mal einrichten, den letzten Benutzer löschen, mit falschem Passwort anmelden.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildApp } from "../src/app.js"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { EventBus } from "../src/execution/bus.js"
import { ExecutionEngine } from "../src/execution/engine.js"
import { ProviderRegistry } from "../src/providers/registry.js"
import { Feedback } from "../src/routing/feedback.js"
import { hashPassword, verifyPassword } from "../src/security/auth.js"

let db: Db
let app: FastifyInstance
/** Das Sitzungs-Cookie, wie es der Browser zurückschicken würde. */
let cookie = ""

beforeAll(async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-auth-"))
	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-auth-ws-"))
	db = openDatabase(dataDir)
	migrate(db)
	const bus = new EventBus()
	const log = () => {}
	const registry = new ProviderRegistry(
		db,
		(e) => bus.emit(e),
		log,
		() => undefined,
	)
	const feedback = new Feedback()
	const engine = new ExecutionEngine({ db, registry, feedback, emit: (e) => bus.emit(e), log, workspaceDir })
	app = await buildApp({
		db,
		bus,
		registry,
		engine,
		feedback,
		secret: Buffer.from("test-secret-0123456789abcdef0123456789abcdef"),
		workspaceDir,
		reposDir: fs.mkdtempSync(path.join(os.tmpdir(), "diriz-auth-repos-")),
	})
})

afterAll(async () => {
	await app.close().catch(() => {})
	db.close()
})

/** Nimmt das Cookie aus einer Antwort entgegen — wie ein Browser. */
function keepCookie(headers: Record<string, unknown>): void {
	const raw = headers["set-cookie"]
	const value = Array.isArray(raw) ? raw[0] : raw
	if (typeof value === "string") {
		cookie = value.split(";")[0] ?? ""
	}
}

describe("Passwort-Hashing", () => {
	it("speichert nie den Klartext und erkennt das richtige Passwort", () => {
		const stored = hashPassword("streng geheim")
		expect(stored).not.toContain("streng geheim")
		expect(stored.startsWith("scrypt$")).toBe(true)
		expect(verifyPassword("streng geheim", stored)).toBe(true)
		expect(verifyPassword("Streng geheim", stored)).toBe(false)
	})

	it("erzeugt für dasselbe Passwort nie denselben Hash (eigenes Salt)", () => {
		expect(hashPassword("gleiches Passwort")).not.toBe(hashPassword("gleiches Passwort"))
	})
})

describe("Erst-Einrichtung", () => {
	it("meldet, dass noch kein Benutzer existiert", async () => {
		const res = await app.inject({ method: "GET", url: "/api/auth/state" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({ configured: false, user: null })
	})

	it("weist zu kurze Passwörter und krumme Namen ab", async () => {
		const kurz = await app.inject({
			method: "POST",
			url: "/api/auth/setup",
			payload: { username: "daniel", password: "kurz" },
		})
		expect(kurz.statusCode).toBe(400)
		const name = await app.inject({
			method: "POST",
			url: "/api/auth/setup",
			payload: { username: "a b", password: "langgenug123" },
		})
		expect(name.statusCode).toBe(400)
	})

	it("legt den ersten Benutzer an und meldet ihn gleich an", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/auth/setup",
			payload: { username: "daniel", password: "langgenug123" },
		})
		expect(res.statusCode).toBe(201)
		keepCookie(res.headers as Record<string, unknown>)
		expect(cookie).toContain("diriz_session=")
		expect(res.json().user.username).toBe("daniel")
	})

	it("lässt sich kein zweites Mal einrichten", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/auth/setup",
			payload: { username: "eindringling", password: "langgenug123" },
		})
		expect(res.statusCode).toBe(409)
	})
})

describe("Türsteher", () => {
	it("lässt ohne Sitzung nichts durch", async () => {
		const res = await app.inject({ method: "GET", url: "/api/agents" })
		expect(res.statusCode).toBe(401)
	})

	it("lässt Health und Version durch — sonst wäre nicht prüfbar, ob der Core läuft", async () => {
		expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200)
		expect((await app.inject({ method: "GET", url: "/api/version" })).statusCode).toBe(200)
	})

	it("lässt mit gültiger Sitzung durch", async () => {
		const res = await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } })
		expect(res.statusCode).toBe(200)
	})

	it("nimmt das Token auch als Bearer entgegen (Werkzeuge ohne Cookie)", async () => {
		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "daniel", password: "langgenug123" },
		})
		const token = login.json().token as string
		const res = await app.inject({
			method: "GET",
			url: "/api/agents",
			headers: { authorization: `Bearer ${token}` },
		})
		expect(res.statusCode).toBe(200)
	})
})

describe("Anmeldung", () => {
	it("weist ein falsches Passwort ab — ohne zu verraten, ob es den Namen gibt", async () => {
		const falsch = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "daniel", password: "falschfalsch" },
		})
		const unbekannt = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "niemand", password: "falschfalsch" },
		})
		expect(falsch.statusCode).toBe(401)
		expect(unbekannt.statusCode).toBe(401)
		expect(falsch.json().error).toBe(unbekannt.json().error)
	})

	it("beendet die Sitzung beim Abmelden", async () => {
		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "daniel", password: "langgenug123" },
		})
		keepCookie(login.headers as Record<string, unknown>)
		const eigen = cookie

		expect(
			(await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: eigen } })).statusCode,
		).toBe(200)
		await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: eigen } })
		expect(
			(await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: eigen } })).statusCode,
		).toBe(401)
	})
})

describe("Benutzerverwaltung", () => {
	beforeAll(async () => {
		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "daniel", password: "langgenug123" },
		})
		keepCookie(login.headers as Record<string, unknown>)
	})

	it("legt weitere Benutzer an, aber keinen doppelten Namen", async () => {
		const erst = await app.inject({
			method: "POST",
			url: "/api/users",
			headers: { cookie },
			payload: { username: "zweiter", password: "langgenug123" },
		})
		expect(erst.statusCode).toBe(201)
		const doppelt = await app.inject({
			method: "POST",
			url: "/api/users",
			headers: { cookie },
			payload: { username: "ZWEITER", password: "langgenug123" },
		})
		expect(doppelt.statusCode).toBe(409)
	})

	it("ändert ein Passwort und wirft dessen offene Sitzungen hinaus", async () => {
		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "zweiter", password: "langgenug123" },
		})
		const fremd = (login.headers["set-cookie"] as string).split(";")[0] ?? ""
		const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie } }))
			.json()
			.find((u: { username: string }) => u.username === "zweiter").id

		expect(
			(await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: fremd } })).statusCode,
		).toBe(200)
		const patch = await app.inject({
			method: "PATCH",
			url: `/api/users/${id}`,
			headers: { cookie },
			payload: { password: "neuesneues123" },
		})
		expect(patch.statusCode).toBe(200)
		// Wer ausgesperrt werden soll, ist auch sofort draussen.
		expect(
			(await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: fremd } })).statusCode,
		).toBe(401)
	})

	it("löscht Benutzer, aber nie den letzten", async () => {
		const users = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json()
		const zweiter = users.find((u: { username: string }) => u.username === "zweiter")
		expect(
			(await app.inject({ method: "DELETE", url: `/api/users/${zweiter.id}`, headers: { cookie } }))
				.statusCode,
		).toBe(200)

		const rest = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json()
		expect(rest).toHaveLength(1)
		const letzter = await app.inject({
			method: "DELETE",
			url: `/api/users/${rest[0].id}`,
			headers: { cookie },
		})
		expect(letzter.statusCode).toBe(409)
	})
})
