/**
 * Tests für den Modell-Katalog und das `llm.md`: Erkennung der Familie,
 * Roundtrip des Datenblatts und die Eignungs-Achse des Routings.
 */

import { describe, expect, it } from "vitest"
import {
	instanceDocs,
	parameterCount,
	parseLlmDoc,
	profileForModel,
	qualityPriorOf,
	renderLlmDoc,
	specFitScore,
	updateLlmDoc,
} from "../src/models.js"

const DATE = "2026-08-24T10:00:00.000Z"

describe("profileForModel", () => {
	it("erkennt Code-, Vision- und Reasoning-Modelle am Namen", () => {
		expect(profileForModel({ modelId: "qwen3-coder-30b-a3b-instruct" }).capabilities).toContain("code")
		expect(profileForModel({ modelId: "llava-v1.6-mistral-7b" }).capabilities).toContain("vision")
		expect(profileForModel({ modelId: "deepseek-r1:32b" }).capabilities).toContain("reasoning")
	})

	it("hält Embedding-Modelle aus dem Auftrags-Routing heraus", () => {
		const profile = profileForModel({ modelId: "nomic-embed-text" })
		expect(profile.capabilities).toEqual([])
		expect(profile.notFor.join(" ")).toContain("Aufträge")
	})

	it("gibt Unbekanntes ehrlich als unbekannt aus, statt etwas zu behaupten", () => {
		const profile = profileForModel({ modelId: "laguna-xs-2.1" })
		expect(profile.family).toBe("Unbekannte Familie")
		expect(profile.capabilities).toEqual([])
	})

	it("ergänzt, was Grösse, Kontext und Quantisierung verraten", () => {
		const small = profileForModel({ modelId: "gemma2:2b", contextWindow: 4096 })
		expect(small.quality).toBe("niedrig")
		expect(small.notFor.join(" ")).toContain("4k Token")

		const big = profileForModel({ modelId: "qwen3:32b", contextWindow: 131072 })
		expect(big.capabilities).toContain("longform")
		expect(big.goodFor.join(" ")).toContain("128k Token")

		// Starke Quantisierung ist ein Qualitätsverlust — und wird so benannt.
		expect(profileForModel({ modelId: "qwen3:32b", quantization: "Q2_K" }).quality).toBe("mittel")
	})

	it("lässt gemeldete Fähigkeiten gewinnen — gemessen schlägt geraten", () => {
		const profile = profileForModel({ modelId: "laguna-xs-2.1", capabilities: ["vision"] })
		expect(profile.capabilities).toEqual(["vision"])
	})

	it("liest die Parameterzahl aus dem Namen", () => {
		expect(parameterCount("qwen3-coder-30b-a3b")).toBe(30)
		expect(parameterCount("mixtral-8x7b-instruct")).toBe(56)
		expect(parameterCount("llama-3.1-8b")).toBe(8)
		expect(parameterCount("gpt-4o")).toBeUndefined()
	})
})

describe("llm.md", () => {
	it("schreibt ein Datenblatt, das sich vollständig zurücklesen lässt", () => {
		const md = renderLlmDoc(
			{ modelId: "qwen3-coder-30b", displayName: "Qwen3 Coder", contextWindow: 32768 },
			DATE,
		)
		const spec = parseLlmDoc(md)
		expect(spec.capabilities).toContain("code")
		expect(spec.contextWindow).toBe(32768)
		expect(spec.quality).toBe("hoch")
		expect(spec.goodFor.length).toBeGreaterThan(0)
		expect(spec.notFor.length).toBeGreaterThan(0)
		// Keine unausgefüllten Platzhalter — das war der Anlass für dieses Dokument.
		expect(md).not.toContain("{{")
		expect(md).not.toContain("Schritt 1")
	})

	it("versteht auch von Hand geschriebene Schreibweisen", () => {
		const spec = parseLlmDoc(
			["- Kontext-Fenster: 32k", "Fähigkeiten: code, json, unsinn", "**Qualitätsklasse:** niedrig"].join("\n"),
		)
		expect(spec.contextWindow).toBe(32768)
		expect(spec.capabilities).toEqual(["code", "json"])
		expect(qualityPriorOf(spec)).toBeLessThan(qualityPriorOf(undefined))
	})

	it("schreibt geänderte Werte zurück, ohne den übrigen Text anzufassen", () => {
		const md = renderLlmDoc({ modelId: "llama3:8b", displayName: "Llama 3", contextWindow: 8192 }, DATE)
		const next = updateLlmDoc(`${md}\n## Hinweise\n\n- Eigene Notiz.\n`, {
			contextWindow: 16384,
			capabilities: ["vision"],
		})
		const spec = parseLlmDoc(next)
		expect(spec.contextWindow).toBe(16384)
		expect(spec.capabilities).toEqual(["vision"])
		expect(next).toContain("Eigene Notiz.")
	})

	it("legt Datenblatt, Changelog und init.md als Startdokumente an", () => {
		const docs = instanceDocs({ modelId: "phi4:14b", displayName: "Phi 4" }, DATE)
		expect(Object.keys(docs).sort()).toEqual(["changelog", "init", "llm"])
		expect(docs.changelog).toContain("ungeprüft")
		expect(docs.init).toContain("Temperature")
	})
})

describe("specFitScore — Stärken und Schwächen im Routing", () => {
	const spec = parseLlmDoc(
		renderLlmDoc({ modelId: "qwen3-coder-30b", displayName: "Qwen3 Coder", contextWindow: 32768 }, DATE),
	)

	it("bleibt neutral, wenn das Datenblatt zum Prompt nichts sagt", () => {
		expect(specFitScore(undefined, "Was ist die Hauptstadt der Schweiz?").value).toBe(0.6)
		expect(specFitScore(spec, "Was ist die Hauptstadt der Schweiz?").value).toBe(0.6)
	})

	it("hebt den Wert, wenn der Prompt eine Stärke trifft", () => {
		const fit = specFitScore(spec, "Schreibe eine Funktion, die Module aus einer Beschreibung erzeugt")
		expect(fit.value).toBeGreaterThan(0.6)
		expect(fit.hits.length).toBeGreaterThan(0)
	})

	it("senkt den Wert, wenn der Prompt eine ausdrückliche Schwäche trifft", () => {
		const fit = specFitScore(spec, "Formuliere einen langen Fliesstext, freies Formulieren erwünscht")
		expect(fit.value).toBeLessThan(0.6)
		expect(fit.misses.length).toBeGreaterThan(0)
	})
})
