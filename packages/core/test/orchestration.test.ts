/**
 * Automatische Zuordnung über den Team-Katalog: Für einen Prompt muss das
 * System ohne manuelle Auswahl beim richtigen Spezialisten landen.
 *
 * Geprüft wird genau die Kette, die auch die Engine im Modus `auto` fährt:
 * Prompt → Task-Profil (`extractProfile`) → `scoreAgents` über alle aktiven
 * Spezialisten. Fällt ein Katalog-Eintrag durch, ist entweder seine
 * Beschreibung zu unscharf oder zwei Spezialisten überschneiden sich.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { blueprintAgentId, MIN_AGENT_SCORE, scoreAgents, toAgentCandidate } from "@diriz/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import { createTask, listAgents } from "../src/db/repositories.js"
import { seedTeamCatalog } from "../src/db/seed.js"
import { extractProfile } from "../src/routing/profile.js"

let dir: string
let db: Db

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-orch-"))
	db = openDatabase(dir)
	migrate(db)
	seedTeamCatalog(db)
})

afterAll(() => {
	db.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

/** Ein Prompt, wie ihn die Engine im Modus `auto` bewerten würde. */
function assign(prompt: string): { slug: string; score: number } {
	const task = createTask(db, { prompt })
	const profile = extractProfile(task)
	const candidates = listAgents(db)
		.filter((a) => a.enabled)
		.map(toAgentCandidate)
	const best = scoreAgents(prompt, profile, candidates)[0]
	return { slug: best.agentId.replace(/^agent-/, ""), score: best.score }
}

/** Prompt → erwarteter Spezialist. Deckt jeden Katalog-Eintrag einmal ab. */
const CASES: [prompt: string, slug: string][] = [
	["Formuliere User-Stories mit Akzeptanzkriterien für den Checkout", "requirements-analyst"],
	["Was soll ins MVP und was kommt später, priorisiere das Backlog", "product-owner"],
	["Plane die Meilensteine und schätze den Aufwand", "agile-coach"],
	["Wie soll die Architektur aussehen, Monolith oder Microservices", "software-architekt"],
	["Entwirf die REST-API mit Endpoints und Fehlerformat", "api-designer"],
	["Entwirf das Datenmodell mit Tabellen und Indizes für die Bestellungen", "datenbank-architekt"],
	["Entwirf den Nutzerfluss und das Layout für das Dashboard", "ux-designer"],
	["Prüfe die Oberfläche auf Barrierefreiheit nach WCAG", "accessibility-spezialist"],
	["Schreib eine React-Komponente für das Login-Formular mit TypeScript", "frontend-entwickler"],
	["Implementiere den Endpoint im Fastify-Backend mit Validierung", "backend-entwickler"],
	["Schreib die iOS-App mit Offline-Synchronisation", "mobile-entwickler"],
	["Baue das Electron-Fenster mit Auto-Update", "desktop-entwickler"],
	["Implementiere den Parser in Rust mit Nebenläufigkeit", "systems-entwickler"],
	["Binde den Zahlungsanbieter Stripe per Webhook an", "integrations-entwickler"],
	["Der Vite-Build ist zu langsam, Monorepo-Konfiguration prüfen", "build-engineer"],
	["Der Merge-Konflikt beim Rebase, wie löse ich das", "git-spezialist"],
	["Baue die ETL-Pipeline für den CSV-Import", "daten-ingenieur"],
	["Trainiere ein Modell zur Klassifikation und miss die Metrik", "ml-ingenieur"],
	["Optimiere den System-Prompt und das RAG-Retrieval", "llm-ingenieur"],
	["Prüfe diesen Diff auf Fehler", "code-reviewer"],
	["Schreib Unit-Tests für die Rechnungsberechnung", "test-engineer"],
	["Baue einen E2E-Test mit Playwright für den Kaufprozess", "testautomatisierung"],
	["Der Import stürzt mit einer Exception ab, finde die Ursache", "debugging-spezialist"],
	["Räum das Legacy-Modul auf, technische Schulden abbauen", "refactoring-spezialist"],
	["Die Seite lädt zu langsam, wo ist der Engpass", "performance-engineer"],
	["Prüfe die Anmeldung auf Schwachstellen wie SQL-Injection", "security-engineer"],
	["Wir brauchen eine GitHub-Actions Pipeline für Build und Deployment", "devops-engineer"],
	["Baue die Terraform-Infrastruktur für Kubernetes auf AWS", "cloud-engineer"],
	["Richte Monitoring mit Metriken und Alerting ein", "sre"],
	["Bereite das Release vor: Version, Changelog, Migrationshinweise", "release-manager"],
	["Schreib eine README mit Schnellstart und Anleitung", "technischer-redakteur"],
	["Übersetze die Oberfläche ins Französische, i18n-Sprachdateien", "lokalisierung"],
	["Wir brauchen ein Löschkonzept für personenbezogene Daten nach DSGVO", "compliance-spezialist"],
]

describe("automatische Spezialisten-Zuordnung über den Katalog", () => {
	it.each(CASES)("„%s“ → %s", (prompt, slug) => {
		const best = assign(prompt)
		expect(best.slug).toBe(slug)
		expect(best.score).toBeGreaterThanOrEqual(MIN_AGENT_SCORE)
	})

	it("deckt jeden Katalog-Spezialisten mit mindestens einem Prompt ab", () => {
		const covered = new Set(CASES.map(([, slug]) => slug))
		const missing = listAgents(db)
			.map((a) => a.id.replace(/^agent-/, ""))
			.filter((slug) => !covered.has(slug))
		expect(missing).toEqual([])
	})

	it("ordnet bei belanglosen Prompts niemanden zu", () => {
		expect(assign("hallo").score).toBeLessThan(MIN_AGENT_SCORE)
	})

	it("straft Spezialisten ab, die Fähigkeiten fordern, die die Task nicht braucht", () => {
		// Reine Textaufgabe: Der Redakteur (fordert `longform`) gewinnt gegen
		// Code-Spezialisten, die `code` fordern und damit das Routing-Gate
		// unnötig verengen würden.
		const best = assign("Schreib ein Handbuch mit Anleitung und Beispielen")
		expect(best.slug).toBe("technischer-redakteur")
		const codeAgent = scoreAgents(
			"Schreib ein Handbuch mit Anleitung und Beispielen",
			extractProfile(createTask(db, { prompt: "Schreib ein Handbuch mit Anleitung und Beispielen" })),
			listAgents(db).map(toAgentCandidate),
		).find((s) => s.agentId === blueprintAgentId("frontend-entwickler"))
		expect(codeAgent?.reasons.join(" ")).toContain("Fordert ungenutzte Fähigkeiten")
	})
})
