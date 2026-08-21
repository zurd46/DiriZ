/**
 * Agent-Scoring-Tests: Determinismus, Namens-/Keyword-Matching,
 * Privacy-Bewertung, Tie-Break, Stopwords.
 */

import { describe, expect, it } from "vitest"
import type { AgentCandidate, AgentProfile } from "../src/agents.js"
import { MIN_AGENT_SCORE, scoreAgents, tokenize } from "../src/agents.js"

const PROFILE: AgentProfile = {
	privacy: "local-only",
	requiredCapabilities: ["code"],
	preferredCapabilities: ["reasoning"],
}

function cand(partial: Partial<AgentCandidate> & { agentId: string }): AgentCandidate {
	return {
		name: partial.agentId,
		description: "",
		requiredCapabilities: [],
		preferredCapabilities: [],
		privacy: "any",
		enabled: true,
		...partial,
	}
}

describe("tokenize", () => {
	it("filtert Stopwords und Punctuation", () => {
		const terms = tokenize("Schreib mir bitte eine React-Komponente!")
		expect(terms).toContain("react")
		expect(terms).toContain("komponente")
		expect(terms).not.toContain("mir")
		expect(terms).not.toContain("bitte")
	})

	it("ist deterministisch", () => {
		const a = tokenize("Hallo Welt, React!")
		const b = tokenize("Hallo Welt, React!")
		expect(a).toEqual(b)
	})
})

describe("scoreAgents", () => {
	it("gibt einen Bonus, wenn der Name im Prompt vorkommt", () => {
		const agents = [cand({ agentId: "a1", name: "Code-Dev" }), cand({ agentId: "a2", name: "Texter" })]
		const scores = scoreAgents("Frag bitte den Code-Dev", PROFILE, agents)
		expect(scores[0].agentId).toBe("a1")
		expect(scores[0].score).toBeGreaterThanOrEqual(10)
	})

	it("matcht Beschreibungsterms gegen den Prompt", () => {
		const agents = [
			cand({ agentId: "a1", name: "Frontend", description: "React, TypeScript, CSS" }),
			cand({ agentId: "a2", name: "Backend", description: "Postgres, Redis, API" }),
		]
		const scores = scoreAgents("Schreib eine React TypeScript Komponente", PROFILE, agents)
		expect(scores[0].agentId).toBe("a1")
		expect(scores[0].score).toBeGreaterThanOrEqual(MIN_AGENT_SCORE)
		expect(scores[1].score).toBe(0)
	})

	it("bewertet Pflicht-Fähigkeiten höher als Wunsch-Fähigkeiten", () => {
		const agents = [
			cand({ agentId: "a1", name: "Coder", description: "code", requiredCapabilities: ["code"] }),
			cand({ agentId: "a2", name: "Schreiber", description: "code" }),
		]
		const scores = scoreAgents(
			"fixe den code bug",
			{ privacy: "local-only", requiredCapabilities: ["code"], preferredCapabilities: [] },
			agents,
		)
		expect(scores[0].agentId).toBe("a1")
		expect(scores[0].score).toBeGreaterThan(scores[1].score)
	})

	it("bevorzugt local-only-Agenten bei local-only-Profil", () => {
		const agents = [
			cand({ agentId: "local", name: "Lokal", description: "react", privacy: "local-only" }),
			cand({ agentId: "cloud", name: "Wolke", description: "react", privacy: "allow-cloud" }),
		]
		const scores = scoreAgents(
			"react code",
			{ privacy: "local-only", requiredCapabilities: [], preferredCapabilities: [] },
			agents,
		)
		expect(scores[0].agentId).toBe("local")
	})

	it("ist deterministisch und tie-brech alphabetisch nach Name", () => {
		const agents = [
			cand({ agentId: "z", name: "Zorro", description: "react" }),
			cand({ agentId: "a", name: "Anna", description: "react" }),
		]
		const s1 = scoreAgents("react app", PROFILE, agents)
		const s2 = scoreAgents("react app", PROFILE, [...agents].reverse())
		expect(s1.map((x) => x.agentId)).toEqual(s2.map((x) => x.agentId))
		expect(s1[0].name).toBe("Anna")
	})

	it("liefert 0 für irrelevante Prompts (unter der Auto-Zuordnungsschwelle)", () => {
		const agents = [cand({ agentId: "a1", name: "Code-Dev", description: "react typescript" })]
		const scores = scoreAgents("hallo", PROFILE, agents)
		expect(scores[0].score).toBeLessThan(MIN_AGENT_SCORE)
	})

	it("liefert Gründe für die Explainability-UI", () => {
		const agents = [cand({ agentId: "a1", name: "Frontend", description: "React TypeScript" })]
		const scores = scoreAgents("react typescript bitte", PROFILE, agents)
		expect(scores[0].reasons.length).toBeGreaterThan(0)
	})
})
