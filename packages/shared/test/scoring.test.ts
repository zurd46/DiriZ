import { describe, expect, it } from "vitest"
import {
	capabilityMatchScore,
	contextFitScore,
	costAwareWeights,
	costScore,
	DEFAULT_WEIGHTS,
	estimateTokens,
	normalizeWeights,
	providerSpreadScore,
	throughputScore,
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
		expect(w.costScore).toBeCloseTo(DEFAULT_WEIGHTS.costScore * 3)
		const sum =
			w.contextFit +
			w.capabilityMatch +
			w.qualityPrior +
			(w.specFit ?? 0) +
			(w.providerSpread ?? 0) +
			(w.throughput ?? 0) +
			w.loadScore +
			w.costScore +
			w.latencyScore
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

	it("providerSpread bevorzugt den freien Rechner", () => {
		expect(providerSpreadScore(0)).toBe(1)
		expect(providerSpreadScore(1)).toBeCloseTo(0.5)
		expect(providerSpreadScore(2)).toBeCloseTo(1 / 3)
		// Unbekannt zählt als frei — ohne Auskunft wird nicht bestraft.
		expect(providerSpreadScore(undefined)).toBe(1)
	})

	it("throughput: gemessenes Tempo hebt, fehlende Messung bleibt neutral", () => {
		expect(throughputScore(undefined)).toBe(0.6)
		expect(throughputScore(60)).toBe(1)
		expect(throughputScore(13)).toBeLessThan(throughputScore(50))
		// Auch ein sehr langsames Modell fällt nicht auf 0 — es bleibt wählbar.
		expect(throughputScore(1)).toBeGreaterThan(0)
	})

	it("estimateTokens ist konservativ (inkl. Output-Reserve)", () => {
		expect(estimateTokens("x".repeat(3500))).toBe(1024 + 1000)
	})

	it("Default-Gewichte summieren auf 1 (Plan §6.2)", () => {
		const sum =
			DEFAULT_WEIGHTS.contextFit +
			DEFAULT_WEIGHTS.capabilityMatch +
			DEFAULT_WEIGHTS.qualityPrior +
			(DEFAULT_WEIGHTS.specFit ?? 0) +
			(DEFAULT_WEIGHTS.providerSpread ?? 0) +
			(DEFAULT_WEIGHTS.throughput ?? 0) +
			DEFAULT_WEIGHTS.loadScore +
			DEFAULT_WEIGHTS.costScore +
			DEFAULT_WEIGHTS.latencyScore
		expect(sum).toBeCloseTo(1)
	})

	it("M8: hostLoad fehlt in alten Settings → bleibt 0 (Backward-Kompatibilität)", () => {
		const w = normalizeWeights({
			contextFit: 1,
			capabilityMatch: 1,
			qualityPrior: 1,
			loadScore: 1,
			costScore: 1,
			latencyScore: 1,
		})
		expect(w.hostLoad ?? 0).toBeCloseTo(0)
		const sum = Object.values(w).reduce((a, b) => a + (b ?? 0), 0)
		expect(sum).toBeCloseTo(1)
	})

	it("M8: hostLoad-Gewicht wird mit den anderen renormiert", () => {
		const w = normalizeWeights({
			contextFit: 3,
			capabilityMatch: 3,
			qualityPrior: 2,
			loadScore: 1,
			costScore: 1,
			latencyScore: 1,
			hostLoad: 1,
		})
		expect(w.hostLoad).toBeCloseTo(1 / 12)
		const sum = Object.values(w).reduce((a, b) => a + (b ?? 0), 0)
		expect(sum).toBeCloseTo(1)
	})
})
