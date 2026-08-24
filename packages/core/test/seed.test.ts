/**
 * Katalog-Seeding: das eingebaute Software-Team wird angelegt, überschreibt
 * nichts Eigenes und kommt nach dem Löschen nicht zurück.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	blueprintAgentId,
	blueprintSwarmId,
	extractDirective,
	parseInitDoc,
	SOFTWARE_TEAM,
	TEAM_SWARMS,
} from "@diriz/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Db } from "../src/db/connection.js"
import { openDatabase } from "../src/db/connection.js"
import { migrate } from "../src/db/migrate.js"
import {
	createAgent,
	deleteAgent,
	getAgent,
	getAgentDoc,
	getSwarm,
	listAgents,
	listSwarms,
	updateAgent,
} from "../src/db/repositories.js"
import { refreshCatalogAgents, refreshCatalogSwarms, seedTeamCatalog } from "../src/db/seed.js"

let dir: string
let db: Db

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-seed-"))
	db = openDatabase(dir)
	migrate(db)
})

afterAll(() => {
	db.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

describe("seedTeamCatalog", () => {
	it("legt das komplette Team samt Swarms an", () => {
		const result = seedTeamCatalog(db)
		expect(result.agents).toHaveLength(SOFTWARE_TEAM.length)
		expect(result.swarms).toHaveLength(TEAM_SWARMS.length)
		expect(listAgents(db)).toHaveLength(SOFTWARE_TEAM.length)

		for (const bp of SOFTWARE_TEAM) {
			const agent = getAgent(db, blueprintAgentId(bp.slug))
			expect(agent, bp.slug).toBeDefined()
			expect(agent?.systemPrompt.length).toBeGreaterThan(50)
			expect(agent?.description.length).toBeGreaterThan(20)
		}
	})

	it("füllt plan.md als wirksame Arbeitsanweisung und init.md als Settings", () => {
		for (const bp of SOFTWARE_TEAM) {
			const id = blueprintAgentId(bp.slug)
			const plan = getAgentDoc(db, id, "plan")?.content ?? ""
			// Ein unausgefülltes plan.md liefert `undefined` — hier muss echter
			// Inhalt herauskommen, sonst erreicht die Vorlage das Modell.
			expect(extractDirective(plan), bp.slug).toBeTruthy()
			expect(extractDirective(plan)).not.toContain("Schritt 1")

			const init = getAgentDoc(db, id, "init")?.content ?? ""
			expect(parseInitDoc(init).temperature, bp.slug).toBe(bp.modelSettings.temperature)
			// init.md wird in die Agenten-Spalte gespiegelt (Auflösungskette).
			expect(getAgent(db, id)?.modelSettings?.maxTokens).toBe(bp.modelSettings.maxTokens)
		}
	})

	it("setzt die Swarm-Mitglieder auf existierende Spezialisten", () => {
		for (const sw of TEAM_SWARMS) {
			const swarm = getSwarm(db, blueprintSwarmId(sw.slug))
			expect(swarm, sw.slug).toBeDefined()
			expect(swarm?.agentIds.length).toBe(sw.agentSlugs.length)
			for (const memberId of swarm?.agentIds ?? []) {
				expect(getAgent(db, memberId), memberId).toBeDefined()
			}
		}
		const komplett = getSwarm(db, blueprintSwarmId("software-team"))
		expect(komplett?.agentIds).toHaveLength(SOFTWARE_TEAM.length)
	})

	it("ist idempotent — ein zweiter Lauf legt nichts an", () => {
		const before = listAgents(db).length
		const again = seedTeamCatalog(db)
		expect(again.agents).toHaveLength(0)
		expect(again.swarms).toHaveLength(0)
		expect(listAgents(db)).toHaveLength(before)
		expect(listSwarms(db)).toHaveLength(TEAM_SWARMS.length)
	})

	it("holt gelöschte Spezialisten nicht zurück", () => {
		const id = blueprintAgentId("code-reviewer")
		expect(deleteAgent(db, id)).toBe(true)
		seedTeamCatalog(db)
		expect(getAgent(db, id)).toBeUndefined()
	})

	it("lässt namensgleiche Eigenbauten in Ruhe", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-seed2-"))
		const db2 = openDatabase(fresh)
		migrate(db2)
		const own = createAgent(db2, { name: "Code-Reviewer", description: "Mein eigener", systemPrompt: "X" })

		seedTeamCatalog(db2)

		expect(getAgent(db2, own.id)?.description).toBe("Mein eigener")
		expect(getAgent(db2, blueprintAgentId("code-reviewer"))).toBeUndefined()
		expect(listAgents(db2).filter((a) => a.name === "Code-Reviewer")).toHaveLength(1)
		// Der Qualitäts-Swarm entsteht trotzdem — nur ohne das fehlende Mitglied.
		const swarm = getSwarm(db2, blueprintSwarmId("qualitaet"))
		expect(swarm?.agentIds).not.toContain(blueprintAgentId("code-reviewer"))

		db2.close()
		fs.rmSync(fresh, { recursive: true, force: true })
	})

	it("rüstet später ergänzte Katalog-Mitglieder in bestehende Swarms nach", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-seed3-"))
		const db3 = openDatabase(fresh)
		migrate(db3)
		seedTeamCatalog(db3)

		// Zustand simulieren: Mitglied fehlt im Swarm, Agent existiert aber.
		const swarmId = blueprintSwarmId("qualitaet")
		const memberId = blueprintAgentId("test-engineer")
		const rest = (getSwarm(db3, swarmId)?.agentIds ?? []).filter((x) => x !== memberId)
		db3.prepare("UPDATE swarms SET agent_ids = ? WHERE id = ?").run(JSON.stringify(rest), swarmId)

		expect(refreshCatalogSwarms(db3)).toContain("qualitaet")
		expect(getSwarm(db3, swarmId)?.agentIds).toContain(memberId)

		db3.close()
		fs.rmSync(fresh, { recursive: true, force: true })
	})
})

/**
 * Katalog-Verbesserungen müssen bei bereits angelegten Spezialisten ankommen —
 * sonst wirkt jede Änderung erst auf einer frischen Datenbank. Angefasst wird
 * nur, was nie von Hand bearbeitet wurde.
 */
describe("refreshCatalogAgents", () => {
	it("zieht unveränderte Spezialisten nach, lässt bearbeitete in Ruhe", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "diriz-refresh-"))
		const db4 = openDatabase(fresh)
		migrate(db4)
		seedTeamCatalog(db4)

		// Zwei Spezialisten „veralten“ lassen: einer bleibt unberührt, einer wird
		// von Hand bearbeitet (das setzt `updatedAt`).
		const alt = blueprintAgentId("frontend-entwickler")
		const bearbeitet = blueprintAgentId("backend-entwickler")
		db4.prepare("UPDATE agents SET description = 'veraltet' WHERE id IN (?, ?)").run(alt, bearbeitet)
		updateAgent(db4, bearbeitet, { description: "von Hand" })

		const changed = refreshCatalogAgents(db4)

		expect(changed).toContain("frontend-entwickler")
		expect(changed).not.toContain("backend-entwickler")
		const bp = SOFTWARE_TEAM.find((b) => b.slug === "frontend-entwickler")
		expect(getAgent(db4, alt)?.description).toBe(bp?.description)
		expect(getAgent(db4, bearbeitet)?.description).toBe("von Hand")

		// Und danach ist Ruhe — der zweite Lauf ändert nichts mehr.
		expect(refreshCatalogAgents(db4)).toEqual([])

		db4.close()
		fs.rmSync(fresh, { recursive: true, force: true })
	})
})
