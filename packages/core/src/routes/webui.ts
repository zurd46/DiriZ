/**
 * Auslieferung der Web-Oberfläche aus dem Core — damit DiriZ im Betrieb
 * **ein** Server auf **einem** Port ist: `npm start` → <http://127.0.0.1:8787>.
 *
 * In der Entwicklung übernimmt Vite (Port 5173) mit HMR und proxyt `/api`
 * hierher; dann existiert kein `dist`-Verzeichnis und diese Registrierung
 * beschränkt sich auf einen erklärenden Hinweis statt einer leeren Seite.
 *
 * SPA-Fallback: Alles, was nicht `/api/**` ist und keine Datei trifft, liefert
 * `index.html` — nötig, damit Deep-Links wie `/tasks` auch beim Neuladen und
 * beim direkten Aufruf funktionieren.
 */

import fs from "node:fs"
import path from "node:path"
import fastifyStatic from "@fastify/static"
import type { FastifyInstance } from "fastify"

/**
 * Sucht das gebaute UI. Der Core läuft aus `packages/core/dist/` (Produktion)
 * oder `packages/core/src/` (tsx), deshalb wird von beiden Orten aus gesucht.
 * `DIRIZ_WEB_DIR` überschreibt die Suche für eigene Deployments.
 */
export function findWebDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.DIRIZ_WEB_DIR) {
		const custom = path.resolve(env.DIRIZ_WEB_DIR)
		return fs.existsSync(path.join(custom, "index.html")) ? custom : undefined
	}
	const here = import.meta.dirname
	const candidates = [
		path.resolve(here, "..", "..", "..", "..", "apps", "web", "dist"), // dist/routes → Repo-Wurzel
		path.resolve(here, "..", "..", "..", "apps", "web", "dist"), // src/routes → Repo-Wurzel
		path.resolve(process.cwd(), "apps", "web", "dist"),
		path.resolve(process.cwd(), "..", "..", "apps", "web", "dist"),
	]
	return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html")))
}

/** Wird die Anfrage von der API bedient? Dann nie das SPA-HTML ausliefern. */
function isApiPath(url: string): boolean {
	return url === "/api" || url.startsWith("/api/")
}

export async function registerWebUi(app: FastifyInstance): Promise<void> {
	const webDir = findWebDir()

	if (!webDir) {
		// Kein Build vorhanden — statt einer weißen Seite eine klare Ansage.
		app.get("/", (_req, reply) => {
			return reply.type("text/html; charset=utf-8").send(
				`<!doctype html><meta charset="utf-8"><title>DiriZ Core</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6;color:#e7ecf6;background:#090c12">
<h1 style="color:#5b8cff">DiriZ Core läuft</h1>
<p>Die API ist bereit, aber die Oberfläche wurde noch nicht gebaut.</p>
<pre style="background:#161c28;padding:1rem;border-radius:8px">npm run build
npm start</pre>
<p>Während der Entwicklung läuft die Oberfläche stattdessen unter
<a style="color:#5b8cff" href="http://localhost:5173">http://localhost:5173</a> (<code>npm run dev</code>).</p>
</body>`,
			)
		})
		// Ohne UI-Build bleibt alles Unbekannte ein sauberes JSON-404.
		app.setNotFoundHandler((req, reply) =>
			reply.code(404).send({ error: `Route ${req.method} ${req.url} existiert nicht` }),
		)
		return
	}

	await app.register(fastifyStatic, {
		root: webDir,
		// `index.html` selbst nie cachen, sonst hängen Nutzer nach einem Deploy
		// auf alten Asset-Hashes fest. Die gehashten Assets dagegen dauerhaft.
		setHeaders: (reply, filePath) => {
			if (filePath.endsWith("index.html")) {
				reply.header("cache-control", "no-cache")
			} else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
				reply.header("cache-control", "public, max-age=31536000, immutable")
			}
		},
	})

	// SPA-Fallback: unbekannte Pfade → index.html, API-Pfade → sauberes 404-JSON.
	app.setNotFoundHandler((req, reply) => {
		if (isApiPath(req.url) || req.method !== "GET") {
			return reply.code(404).send({ error: `Route ${req.method} ${req.url} existiert nicht` })
		}
		return reply.sendFile("index.html")
	})
}
