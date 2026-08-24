/**
 * E2E-Vorbereitung: anmelden.
 *
 * Seit der Anmeldepflicht steht vor der Anwendung ein Vorhang — ohne gültige
 * Sitzung sehen die Rauchtests nur das Login-Formular. Hier wird deshalb
 * einmalig ein Testbenutzer angelegt (oder angemeldet, wenn das Datenverzeichnis
 * wiederverwendet wird) und sein Sitzungs-Cookie als `storageState` abgelegt.
 * Jeder Test startet damit als angemeldeter Benutzer — genau wie ein Mensch,
 * der die App zum zweiten Mal öffnet.
 */

import fs from "node:fs"
import path from "node:path"
import type { FullConfig } from "@playwright/test"

export const AUTH_FILE = path.join(import.meta.dirname, ".auth", "state.json")

const USER = { username: "e2e-tester", password: "e2e-passwort-123" }

export default async function globalSetup(config: FullConfig): Promise<void> {
	const base = config.projects[0]?.use?.baseURL ?? "http://127.0.0.1:8788"

	const state = (await (await fetch(`${base}/api/auth/state`)).json()) as { configured: boolean }
	const res = await fetch(`${base}/api/auth/${state.configured ? "login" : "setup"}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(USER),
	})
	if (!res.ok) {
		throw new Error(`E2E-Anmeldung fehlgeschlagen: HTTP ${res.status} ${await res.text()}`)
	}

	// Das Cookie aus der Antwort in Playwrights Format übersetzen.
	const setCookie = res.headers.get("set-cookie") ?? ""
	const value = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? ""
	const url = new URL(base)
	fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
	fs.writeFileSync(
		AUTH_FILE,
		JSON.stringify({
			cookies: [
				{
					name: "diriz_session",
					value: decodeURIComponent(value),
					domain: url.hostname,
					path: "/",
					expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
					httpOnly: true,
					secure: false,
					sameSite: "Lax",
				},
			],
			origins: [],
		}),
	)
}
