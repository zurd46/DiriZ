/**
 * Anmeldung: Login, Logout, Benutzerverwaltung — und der Türsteher.
 *
 * Der Ablauf ist bewusst einfach gehalten:
 *
 *  * `GET  /api/auth/state`    — offen: Gibt es schon Benutzer? Bin ich angemeldet?
 *  * `POST /api/auth/setup`    — offen **nur solange es keinen Benutzer gibt**:
 *    legt den ersten an. Kein voreingestelltes „admin/admin", das jemand
 *    stehen lässt.
 *  * `POST /api/auth/login`    — setzt das Sitzungs-Cookie.
 *  * `POST /api/auth/logout`   — beendet die Sitzung.
 *  * `GET/POST/PATCH/DELETE /api/users` — Verwaltung, nur angemeldet.
 *
 * Alles andere unter `/api` verlangt eine gültige Sitzung. Ausgenommen sind
 * `health` und `version`: Sie sagen nichts Vertrauliches und werden gebraucht,
 * um überhaupt festzustellen, ob der Core läuft.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { AppContext } from "../app.js"
import {
	countUsers,
	createSession,
	createUser,
	deleteSession,
	deleteSessionsOfUser,
	deleteUser,
	getUser,
	getUserByName,
	listUsers,
	purgeExpiredSessions,
	setUserPassword,
	touchUserLogin,
	userBySession,
} from "../db/repositories.js"
import {
	createSessionToken,
	hashPassword,
	hashToken,
	passwordProblem,
	usernameProblem,
	verifyPassword,
} from "../security/auth.js"

/** Name des Sitzungs-Cookies. */
const COOKIE = "diriz_session"

/** Laufzeit einer Sitzung: lang genug, um nicht täglich zu nerven. */
const SESSION_DAYS = 30

/**
 * Bremse gegen Rateversuche.
 *
 * Ohne sie darf jeder, der den Port erreicht, beliebig oft Passwörter
 * durchprobieren — bei einem Dienst, der über einen Tunnel erreichbar sein
 * kann, ist das keine theoretische Sorge. Gezählt wird je Benutzername; nach
 * `MAX_ATTEMPTS` Fehlversuchen ist der Name für `LOCK_MS` gesperrt, ein
 * erfolgreicher Login setzt den Zähler zurück.
 *
 * Bewusst im Speicher: Ein Neustart hebt die Sperre auf — das ist kein Loch,
 * denn wer den Prozess neu starten kann, hat ohnehin Zugriff auf die Maschine.
 * Dafür kostet es keine Schreiblast und keine Tabelle.
 */
const MAX_ATTEMPTS = 5
const LOCK_MS = 60_000
const attempts = new Map<string, { count: number; until: number }>()

/** Verbleibende Sperrzeit in Sekunden — 0, wenn nicht gesperrt. */
function lockedFor(username: string): number {
	const entry = attempts.get(username.toLowerCase())
	if (!entry || entry.until <= Date.now()) {
		return 0
	}
	return Math.ceil((entry.until - Date.now()) / 1000)
}

function noteFailure(username: string): void {
	const key = username.toLowerCase()
	const entry = attempts.get(key) ?? { count: 0, until: 0 }
	entry.count += 1
	if (entry.count >= MAX_ATTEMPTS) {
		entry.until = Date.now() + LOCK_MS
		entry.count = 0
	}
	attempts.set(key, entry)
}

function noteSuccess(username: string): void {
	attempts.delete(username.toLowerCase())
}

/** Pfade, die ohne Anmeldung erreichbar bleiben müssen. */
const OPEN_PATHS = new Set([
	"/api/health",
	"/api/version",
	"/api/auth/state",
	"/api/auth/setup",
	"/api/auth/login",
	"/api/auth/logout",
])

/** Liest das Sitzungs-Token aus Cookie oder `Authorization: Bearer`. */
function tokenOf(req: FastifyRequest): string | undefined {
	const cookie = req.headers.cookie
	if (cookie) {
		for (const part of cookie.split(";")) {
			const [name, ...rest] = part.trim().split("=")
			if (name === COOKIE && rest.length > 0) {
				return decodeURIComponent(rest.join("="))
			}
		}
	}
	const auth = req.headers.authorization
	// Für Werkzeuge ohne Cookie-Jar (curl, Desktop-Integrationen).
	return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
}

function setCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
	const maxAge = SESSION_DAYS * 24 * 60 * 60
	// `Secure` nur über HTTPS — sonst käme das Cookie im lokalen Betrieb
	// (http://127.0.0.1) nie an.
	const secure = req.protocol === "https" ? "; Secure" : ""
	reply.header(
		"set-cookie",
		`${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
	)
}

function clearCookie(reply: FastifyReply): void {
	reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
	// Türsteher: läuft vor jeder Route.
	app.addHook("preHandler", (req, reply, done) => {
		const path = req.url.split("?")[0] ?? ""
		if (!path.startsWith("/api/") || OPEN_PATHS.has(path)) {
			done()
			return
		}
		// Solange kein Benutzer existiert, ist DiriZ wie bisher offen — sonst
		// käme man nach dem ersten Start nicht einmal an die Einrichtung.
		if (countUsers(ctx.db) === 0) {
			done()
			return
		}
		const token = tokenOf(req)
		const user = token ? userBySession(ctx.db, hashToken(token)) : undefined
		if (!user) {
			reply.code(401).send({ error: "Nicht angemeldet" })
			return
		}
		;(req as FastifyRequest & { user?: unknown }).user = user
		done()
	})

	app.get("/api/auth/state", (req) => {
		const token = tokenOf(req)
		const user = token ? userBySession(ctx.db, hashToken(token)) : undefined
		return {
			// `false` heisst: Erst-Einrichtung, die Oberfläche zeigt das Formular
			// zum Anlegen des ersten Benutzers.
			configured: countUsers(ctx.db) > 0,
			user: user ?? null,
		}
	})

	app.post<{ Body: { username?: string; password?: string } }>("/api/auth/setup", (req, reply) => {
		if (countUsers(ctx.db) > 0) {
			return reply.code(409).send({ error: "Es gibt bereits Benutzer — bitte anmelden" })
		}
		const username = (req.body?.username ?? "").trim()
		const password = req.body?.password ?? ""
		const problem = usernameProblem(username) ?? passwordProblem(password)
		if (problem) {
			return reply.code(400).send({ error: problem })
		}
		const user = createUser(ctx.db, username, hashPassword(password))
		const { token, hash } = createSessionToken()
		createSession(ctx.db, user.id, hash, expiry())
		touchUserLogin(ctx.db, user.id)
		setCookie(req, reply, token)
		return reply.code(201).send({ user, token })
	})

	app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", (req, reply) => {
		const username = (req.body?.username ?? "").trim()
		const password = req.body?.password ?? ""

		const sperre = lockedFor(username)
		if (sperre > 0) {
			return reply.code(429).send({ error: `Zu viele Fehlversuche — bitte ${sperre} Sekunden warten` })
		}

		const found = getUserByName(ctx.db, username)
		// Eine einzige Fehlermeldung für „kein solcher Benutzer" und „falsches
		// Passwort" — alles andere verrät, welche Namen existieren.
		if (!found || !verifyPassword(password, found.passwordHash)) {
			noteFailure(username)
			return reply.code(401).send({ error: "Benutzername oder Passwort falsch" })
		}
		noteSuccess(username)
		purgeExpiredSessions(ctx.db)
		const { token, hash } = createSessionToken()
		createSession(ctx.db, found.id, hash, expiry())
		touchUserLogin(ctx.db, found.id)
		setCookie(req, reply, token)
		return { user: getUser(ctx.db, found.id), token }
	})

	app.post("/api/auth/logout", (req, reply) => {
		const token = tokenOf(req)
		if (token) {
			deleteSession(ctx.db, hashToken(token))
		}
		clearCookie(reply)
		return { ok: true }
	})

	/* ----------------------------- Benutzerverwaltung ---------------------------- */

	app.get("/api/users", () => listUsers(ctx.db))

	app.post<{ Body: { username?: string; password?: string } }>("/api/users", (req, reply) => {
		const username = (req.body?.username ?? "").trim()
		const password = req.body?.password ?? ""
		const problem = usernameProblem(username) ?? passwordProblem(password)
		if (problem) {
			return reply.code(400).send({ error: problem })
		}
		if (getUserByName(ctx.db, username)) {
			return reply.code(409).send({ error: "Diesen Benutzernamen gibt es bereits" })
		}
		return reply.code(201).send(createUser(ctx.db, username, hashPassword(password)))
	})

	app.patch<{ Params: { id: string }; Body: { password?: string } }>("/api/users/:id", (req, reply) => {
		const password = req.body?.password ?? ""
		const problem = passwordProblem(password)
		if (problem) {
			return reply.code(400).send({ error: problem })
		}
		if (!getUser(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Benutzer nicht gefunden" })
		}
		setUserPassword(ctx.db, req.params.id, hashPassword(password))
		// Ein geändertes Passwort beendet alle Sitzungen dieses Benutzers — sonst
		// bliebe ein Mitleser angemeldet, obwohl man ihn gerade aussperren wollte.
		deleteSessionsOfUser(ctx.db, req.params.id)
		return { ok: true }
	})

	app.delete<{ Params: { id: string } }>("/api/users/:id", (req, reply) => {
		if (!getUser(ctx.db, req.params.id)) {
			return reply.code(404).send({ error: "Benutzer nicht gefunden" })
		}
		const res = deleteUser(ctx.db, req.params.id)
		if (!res.ok) {
			return reply.code(409).send({ error: res.reason ?? "Löschen nicht möglich" })
		}
		return { ok: true }
	})
}

function expiry(): string {
	return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}
