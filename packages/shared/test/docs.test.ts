/**
 * Tests für die Agenten-Dokumente: `init.md`-Parser (Voreinstellungen des
 * LLM-Modells), Render-Roundtrip und Changelog-Anhang.
 */

import { describe, expect, it } from "vitest"
import {
	AGENT_DOC_FILES,
	appendChangelogEntry,
	defaultAgentDoc,
	isAgentDocKind,
	parseInitDoc,
	renderInitDoc,
} from "../src/docs.js"

describe("parseInitDoc", () => {
	it("liest Listen-, Fett- und Gleichheits-Schreibweisen", () => {
		const md = [
			"# init.md — Code-Dev",
			"",
			"Freitext, der ignoriert wird.",
			"",
			"- **Temperature:** 0.35",
			"- max_tokens: 4096",
			"* Top-P = 0.9",
			"Repeat-Penalty: 1.1",
			"- Stop: ```file:, ENDE",
		].join("\n")
		expect(parseInitDoc(md)).toEqual({
			temperature: 0.35,
			maxTokens: 4096,
			topP: 0.9,
			repeatPenalty: 1.1,
			stop: ["file:", "ENDE"],
		})
	})

	it("ignoriert Platzhalter und leere Werte", () => {
		const md = ["- Temperature: {{TEMPERATURE}}", "- Max-Tokens: —", "- Top-K: default", "- Seed: 42"].join(
			"\n",
		)
		expect(parseInitDoc(md)).toEqual({ seed: 42 })
	})

	it("versteht „32k“ als 32768 und Komma als Dezimaltrenner", () => {
		expect(parseInitDoc("- Max-Tokens: 32k")).toEqual({ maxTokens: 32768 })
		expect(parseInitDoc("- Temperature: 0,7")).toEqual({ temperature: 0.7 })
	})

	it("nimmt einen mehrzeiligen System-Prompt-Abschnitt", () => {
		const md = [
			"## System-Prompt",
			"",
			"Du bist ein Reviewer.",
			"Antworte knapp.",
			"",
			"## Notizen",
			"egal",
		].join("\n")
		expect(parseInitDoc(md).systemPrompt).toBe("Du bist ein Reviewer.\nAntworte knapp.")
	})

	it("liefert für leere Dokumente keine Einstellungen", () => {
		expect(parseInitDoc("")).toEqual({})
		expect(parseInitDoc(defaultAgentDoc("init", "Neu", "2026-08-23T10:00:00.000Z"))).toEqual({})
	})
})

describe("renderInitDoc", () => {
	it("ist die Umkehrung von parseInitDoc (Roundtrip)", () => {
		const settings = {
			temperature: 0.2,
			maxTokens: 8192,
			topP: 0.95,
			stop: ["<<END>>"],
			systemPrompt: "Du bist ein Architekt.",
		}
		expect(parseInitDoc(renderInitDoc(settings, "Archi"))).toEqual(settings)
	})
})

describe("appendChangelogEntry", () => {
	it("setzt neue Einträge vor den bestehenden ersten Eintrag", () => {
		const before = defaultAgentDoc("changelog", "Code-Dev", "2026-08-01T00:00:00.000Z")
		const after = appendChangelogEntry(before, "Bearbeitet: Name", "2026-08-23T09:00:00.000Z")
		const bullets = after.split("\n").filter((l) => l.startsWith("- "))
		expect(bullets[0]).toBe("- 2026-08-23 — Bearbeitet: Name")
		expect(bullets[1]).toBe("- 2026-08-01 — Spezialist angelegt")
	})

	it("hängt an, wenn das Dokument keine Liste enthält", () => {
		expect(appendChangelogEntry("# Leer", "Erster Eintrag", "2026-08-23T09:00:00.000Z")).toContain(
			"- 2026-08-23 — Erster Eintrag",
		)
	})
})

describe("Dokument-Typen", () => {
	it("kennt genau plan/changelog/init", () => {
		expect(AGENT_DOC_FILES).toEqual({ plan: "plan.md", changelog: "changelog.md", init: "init.md" })
		expect(isAgentDocKind("init")).toBe(true)
		expect(isAgentDocKind("readme")).toBe(false)
	})
})
