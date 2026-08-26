/**
 * CI-Server-Rauchtest: startet den **gebauten** Core in Wegwerf-Verzeichnissen
 * und prüft, dass er API und Oberfläche ausliefert — derselbe Zustand, den
 * `npm run serve` im Betrieb produziert (README → „Befehle").
 *
 * Kein Provider, keine Task: Es geht um den Zustand „Core ist up", nicht um
 * LLM-Anfragen. Exit 0 = gesund, Exit 1 = kaputt.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const PORT = Number(process.env.DIRIZ_SMOKE_PORT ?? 8791)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-ci-data-"))
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-ci-ws-"))

const core = spawn(process.execPath, ["packages/core/dist/index.js"], {
	cwd: ROOT,
	env: {
		...process.env,
		DIRIZ_PORT: String(PORT),
		DIRIZ_DATA_DIR: dataDir,
		DIRIZ_WORKSPACE_DIR: workspaceDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
})

const coreLog = []
core.stdout.on("data", (d) => coreLog.push(String(d)))
core.stderr.on("data", (d) => coreLog.push(String(d)))
core.on("exit", (code) => coreLog.push(`[core exit ${code}]`))

const fail = (msg) => {
	console.error(`\n✗ ${msg}\n`)
	console.error("Core-Log (letzte 2000 Zeichen):\n" + coreLog.join("").slice(-2000))
	core.kill("SIGTERM")
	process.exit(1)
}

const ok = (msg) => console.log(`  ✓ ${msg}`)

const waitForHealth = async (timeoutMs) => {
	const t0 = Date.now()
	while (Date.now() - t0 < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/health`)
			if (res.ok) return await res.json()
		} catch {
			// noch nicht up
		}
		await new Promise((r) => setTimeout(r, 300))
	}
	throw new Error(`Core antwortet nicht auf /api/health nach ${timeoutMs} ms`)
}

try {
	console.log("Starte gebauten Core …")
	const health = await waitForHealth(30_000)
	ok(`Core up · Schema v${health.schemaVersion}`)

	const version = await (await fetch(`${BASE}/api/version`)).json()
	if (!version.name || !version.version) throw new Error(`/api/version unvollständig: ${JSON.stringify(version)}`)
	ok(`Version ${version.name} ${version.version} · Node ${version.node}`)

	const index = await fetch(`${BASE}/`)
	const html = await index.text()
	if (!index.ok || !html.includes("<html")) throw new Error(`/ liefert kein HTML (HTTP ${index.status})`)
	ok("Oberfläche: index.html ausgeliefert")

	const assetMatch = html.match(/src="([^"]+\.js)"/)
	if (assetMatch) {
		const asset = await fetch(`${BASE}${assetMatch[1]}`)
		if (!asset.ok) throw new Error(`Asset ${assetMatch[1]} nicht erreichbar (HTTP ${asset.status})`)
		ok(`Asset geladen: ${assetMatch[1]}`)
	}

	const spa = await fetch(`${BASE}/tasks`)
	if (!spa.ok || !(await spa.text()).includes("<html")) throw new Error("SPA-Fallback /tasks liefert kein index.html")
	ok("SPA-Fallback: Deep-Link /tasks → index.html")

	const missing = await fetch(`${BASE}/api/nicht-existiert`)
	if (missing.status !== 404) throw new Error(`Unbekannte API-Route erwartet 404, bekam ${missing.status}`)
	ok("Unbekannte API-Route → 404 (JSON)")

	const protectedRoute = await fetch(`${BASE}/api/providers`)
	if (protectedRoute.status !== 200) {
		throw new Error(`/api/providers im Erst-Einrichtungs-Zustand erwartet 200, bekam ${protectedRoute.status}`)
	}
	ok("Erst-Einrichtung: ohne Benutzer bleibt die API offen (Setup-Zustand)")

	const setup = await fetch(`${BASE}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: "cismoke", password: "ci-smoke-passwort" }),
	})
	if (setup.status !== 201) throw new Error(`/api/auth/setup erwartet 201, bekam ${setup.status}`)
	ok("Erstbenutzer angelegt (/api/auth/setup → 201)")

	const afterUser = await fetch(`${BASE}/api/providers`)
	if (afterUser.status !== 401) {
		throw new Error(`/api/providers nach Benutzeranlage ohne Sitzung erwartet 401, bekam ${afterUser.status}`)
	}
	ok("API-Türsteher: /api/providers ohne Sitzung → 401")

	console.log("\n═══ RAUCHTEST BESTANDEN ═══")
	core.kill("SIGTERM")
	setTimeout(() => process.exit(0), 500)
} catch (e) {
	fail(e instanceof Error ? e.message : String(e))
}
