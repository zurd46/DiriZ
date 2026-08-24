/**
 * End-to-End-Tests (Playwright).
 *
 * Getestet wird bewusst das **gebaute** Artefakt: `npm run serve` baut Core und
 * Web und startet den Core, der die Oberfläche selbst ausliefert. Damit prüft
 * der E2E-Lauf denselben Zustand, den auch Nutzerinnen und Nutzer starten —
 * ein Dev-Server mit HMR kann Fehler verdecken, die erst im Build auftreten.
 *
 * Isolierter Port und eigenes Datenverzeichnis, damit ein laufender
 * Entwicklungs-Core (:8787) und die echten Daten unberührt bleiben.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.DIRIZ_E2E_PORT ?? 8788)
const BASE_URL = `http://127.0.0.1:${PORT}`

/** Wegwerf-Verzeichnisse: Der E2E-Lauf fasst weder DB noch Workspace an. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-e2e-data-"))
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-e2e-ws-"))

export default defineConfig({
	testDir: "./apps/web/tests",
	timeout: 30_000,
	expect: { timeout: 5_000 },
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never" }]]
		: [["list"], ["html", { open: "never" }]],
	// Vor allen Tests: einmal anmelden (siehe `global-setup.ts`). Ohne Sitzung
	// zeigt die Anwendung nur noch den Anmeldebildschirm.
	globalSetup: "./apps/web/tests/global-setup.ts",
	use: {
		baseURL: BASE_URL,
		storageState: "./apps/web/tests/.auth/state.json",
		trace: "retry-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "npm run serve",
		url: `${BASE_URL}/api/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: "ignore",
		stderr: "pipe",
		env: {
			DIRIZ_PORT: String(PORT),
			DIRIZ_DATA_DIR: dataDir,
			DIRIZ_WORKSPACE_DIR: workspaceDir,
		},
	},
})
