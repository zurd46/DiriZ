/**
 * Katalog-Integrität: eindeutige Identitäten, vollständige Rollen,
 * auflösbare Swarms und Dokumente, die wirklich Inhalt tragen.
 */

import { describe, expect, it } from "vitest"
import {
	blueprintDocs,
	blueprintsOfDiscipline,
	findBlueprint,
	renderBlueprintPlan,
	SOFTWARE_TEAM,
	TEAM_SWARMS,
} from "../src/catalog.js"
import { extractDirective, parseInitDoc } from "../src/docs.js"

const DATE = "2026-08-24T10:00:00.000Z"

describe("SOFTWARE_TEAM", () => {
	it("hat eindeutige Slugs und Namen", () => {
		const slugs = SOFTWARE_TEAM.map((bp) => bp.slug)
		const names = SOFTWARE_TEAM.map((bp) => bp.name.toLowerCase())
		expect(new Set(slugs).size).toBe(slugs.length)
		expect(new Set(names).size).toBe(names.length)
	})

	it("liefert je Spezialist eine vollständige Rolle", () => {
		for (const bp of SOFTWARE_TEAM) {
			expect(bp.systemPrompt.length, bp.slug).toBeGreaterThan(120)
			expect(bp.description.split(",").length, bp.slug).toBeGreaterThanOrEqual(8)
			expect(bp.mission.length, bp.slug).toBeGreaterThan(40)
			expect(bp.approach.length, bp.slug).toBeGreaterThanOrEqual(4)
			expect(bp.guardrails.length, bp.slug).toBeGreaterThanOrEqual(3)
			expect(bp.modelSettings.temperature, bp.slug).toBeTypeOf("number")
			expect(bp.modelSettings.maxTokens, bp.slug).toBeTypeOf("number")
		}
	})

	it("fordert nur Fähigkeiten, die es auch als Wunsch nicht doppelt gibt", () => {
		for (const bp of SOFTWARE_TEAM) {
			const doubled = bp.requiredCapabilities.filter((c) => bp.preferredCapabilities.includes(c))
			expect(doubled, bp.slug).toEqual([])
			// Ein hartes Gate über drei Fähigkeiten schliesst praktisch jedes
			// lokale Modell aus — das wäre kein Spezialist, sondern eine Sperre.
			expect(bp.requiredCapabilities.length, bp.slug).toBeLessThanOrEqual(2)
		}
	})

	it("gruppiert lückenlos in Fachbereiche", () => {
		const disciplines = [...new Set(SOFTWARE_TEAM.map((bp) => bp.discipline))]
		const summed = disciplines.reduce((n, d) => n + blueprintsOfDiscipline(d).length, 0)
		expect(summed).toBe(SOFTWARE_TEAM.length)
	})

	it("findet Blueprints über den Slug", () => {
		expect(findBlueprint("code-reviewer")?.name).toBe("Code-Reviewer")
		expect(findBlueprint("gibt-es-nicht")).toBeUndefined()
	})
})

describe("Dokumente eines Blueprints", () => {
	it("erzeugt aus plan.md eine wirksame Arbeitsanweisung", () => {
		for (const bp of SOFTWARE_TEAM) {
			const directive = extractDirective(renderBlueprintPlan(bp, DATE))
			expect(directive, bp.slug).toBeTruthy()
			expect(directive, bp.slug).toContain("Auftrag")
			// Vorlagen-Platzhalter dürfen nirgends überleben.
			expect(directive).not.toContain("Schritt 1")
			expect(directive).not.toContain("plan.md")
		}
	})

	it("erzeugt ein init.md, das sich wieder in Settings zurücklesen lässt", () => {
		for (const bp of SOFTWARE_TEAM) {
			const parsed = parseInitDoc(blueprintDocs(bp, DATE).init)
			expect(parsed.temperature, bp.slug).toBe(bp.modelSettings.temperature)
			expect(parsed.maxTokens, bp.slug).toBe(bp.modelSettings.maxTokens)
		}
	})
})

describe("TEAM_SWARMS", () => {
	it("verweist nur auf existierende Spezialisten", () => {
		for (const sw of TEAM_SWARMS) {
			expect(sw.agentSlugs.length, sw.slug).toBeGreaterThan(0)
			for (const slug of sw.agentSlugs) {
				expect(findBlueprint(slug), `${sw.slug} → ${slug}`).toBeDefined()
			}
		}
	})

	it("führt jeden Spezialisten in genau einem Fachbereichs-Swarm", () => {
		const fachbereiche = TEAM_SWARMS.filter((sw) => sw.slug !== "software-team")
		const counts = new Map<string, number>()
		for (const sw of fachbereiche) {
			for (const slug of sw.agentSlugs) {
				counts.set(slug, (counts.get(slug) ?? 0) + 1)
			}
		}
		for (const bp of SOFTWARE_TEAM) {
			expect(counts.get(bp.slug), bp.slug).toBe(1)
		}
	})

	it("enthält im Gesamt-Swarm das ganze Team", () => {
		const all = TEAM_SWARMS.find((sw) => sw.slug === "software-team")
		expect(all?.agentSlugs).toHaveLength(SOFTWARE_TEAM.length)
	})
})
