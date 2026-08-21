import { describe, expect, it } from "vitest"
import {
	capabilityMatchScore,
	contextFitScore,
	costAwareWeights,
	costScore,
	DEFAULT_WEIGHTS,
	estimateTokens,
	normalizeWeights,
} from "../src/scoring.js"

describe("scoring", () => {
	it("contextFit ist 1.0 bei 1.3× estTokens und fällt darunter linear ab", () => {
		expect(contextFitScore(13_000, 10_000)).toBe(1)
		expect(contextFitScore(10_000, 10_000)).toBeLessThan(1)
		expect(contextFitScore(5_000, 10_000)).toBe(0)
		expect(contextFitScore(9_000, 10_000)).toBeGreaterThan(contextFitScore(7_000, 10_000))
	})

	it("capabilityMatch: Pflicht-Capabilities sind Pflicht, Extras sind Bonus", () => {
		expect(capabilityMatchScore(["code"], [], ["code"])).toBe(0.6)
		expect(capabilityMatchScore(["code"], ["json", "reasoning"], ["code", "json"])).toBeCloseTo(0.65)
		expect(capabilityMatchScore(["code"], [], ["reasoning"])).toBe(0)
	})

	it("costScore: lokal ist 1.0, teure Cloud sinkt", () => {
		expect(costScore(undefined)).toBe(1)
		expect(costScore({ in: 1, out: 1 })).toBeGreaterThan(0.9)
		expect(costScore({ in: 20, out: 20 })).toBeCloseTo(0.3)
	})

	it("costAware verdreifacht das cost-Gewicht und renormiert auf 1", () => {
		const w = costAwareWeights()
		expect(w.costScore).toBeCloseTo(0.21)
		const sum = w.contextFit + w.capabilityMatch + w.qualityPrior + w.loadScore + w.costScore + w.latencyScore
		expect(sum).toBeCloseTo(1)
	})

	it("normalizeWeights summiert auf 1", () => {
		const w = normalizeWeights({
			contextFit: 1,
			capabilityMatch: 1,
			qualityPrior: 1,
			loadScore: 1,
			costScore: 1,
			latencyScore: 1,
		})
		expect(w.contextFit).toBeCloseTo(1 / 6)
	})

	it("estimateTokens ist konservativ (inkl. Output-Reserve)", () => {
		expect(estimateTokens("x".repeat(3500))).toBe(1024 + 1000)
	})

	it("Default-Gewichte summieren auf 1 (Plan §6.2)", () => {
		const sum =
			DEFAULT_WEIGHTS.contextFit +
			DEFAULT_WEIGHTS.capabilityMatch +
			DEFAULT_WEIGHTS.qualityPrior +
			DEFAULT_WEIGHTS.loadScore +
			DEFAULT_WEIGHTS.costScore +
			DEFAULT_WEIGHTS.latencyScore
		expect(sum).toBeCloseTo(1)
	})
})
