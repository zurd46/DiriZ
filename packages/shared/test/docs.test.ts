/**
 * Tests für die Agenten-Dokumente: `init.md`-Parser (Voreinstellungen des
 * LLM-Modells), Render-Roundtrip und Changelog-Anhang.
 */

import { describe, expect, it } from "vitest"
import {
	AGENT_DOC_FILES,
	appendChangelogEntry,
	composeSystemPrompt,
	defaultAgentDoc,
	defaultDoc,
	docKindsFor,
	extractDirective,
	isAgentDocKind,
	parseInitDoc,
	renderDocTemplate,
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
	it("kennt plan/llm/changelog/init", () => {
		expect(AGENT_DOC_FILES).toEqual({
			plan: "plan.md",
			llm: "llm.md",
			changelog: "changelog.md",
			init: "init.md",
		})
		expect(isAgentDocKind("init")).toBe(true)
		expect(isAgentDocKind("llm")).toBe(true)
		expect(isAgentDocKind("readme")).toBe(false)
	})

	it("gibt jeder Ebene die Dokumente, die zu ihr gehören", () => {
		// Ein Modell hat keinen Auftrag, ein Spezialist kein Datenblatt.
		expect(docKindsFor("agent")).toEqual(["plan", "changelog", "init"])
		expect(docKindsFor("provider")).toEqual(["plan", "changelog", "init"])
		expect(docKindsFor("instance")).toEqual(["llm", "changelog", "init"])
	})
})

describe("extractDirective", () => {
	it("liefert nichts für eine unbearbeitete Vorlage", () => {
		expect(extractDirective(defaultDoc("plan", "agent", "Code-Dev", "2026-08-23"))).toBeUndefined()
		expect(extractDirective(defaultDoc("plan", "instance", "qwen3:8b", "2026-08-23"))).toBeUndefined()
		expect(extractDirective("")).toBeUndefined()
	})

	it("entfernt Titel, Datum und Platzhalter, behält den echten Inhalt", () => {
		const md = [
			"# plan.md — Code-Dev",
			"",
			"**Erstellt am:** 2026-08-23",
			"",
			"## 1. Auftrag",
			"",
			"Du reviewst TypeScript-Diffs.",
			"",
			"## 2. Vorgehen",
			"",
			"- Schritt 1",
			"- Schritt 2",
			"",
			"## 3. Leitplanken",
			"",
			"- Niemals Dateien löschen.",
		].join("\n")
		const directive = extractDirective(md)
		expect(directive).toContain("Du reviewst TypeScript-Diffs.")
		expect(directive).toContain("Niemals Dateien löschen.")
		// Titel/Datum und die reine Platzhalter-Sektion fallen weg.
		expect(directive).not.toContain("plan.md — Code-Dev")
		expect(directive).not.toContain("Erstellt am")
		expect(directive).not.toContain("Schritt 1")
		expect(directive).not.toContain("2. Vorgehen")
		// Überschriften mit Inhalt bleiben stehen.
		expect(directive).toContain("## 1. Auftrag")
	})
})

describe("composeSystemPrompt", () => {
	it("ohne Deklaration bleibt es beim reinen System-Prompt", () => {
		expect(composeSystemPrompt([{ label: "Agent", systemPrompt: "Du bist knapp." }])).toBe("Du bist knapp.")
		expect(composeSystemPrompt([{ label: "Agent" }])).toBe("")
	})

	it("der zuletzt gesetzte System-Prompt gewinnt", () => {
		const out = composeSystemPrompt([
			{ label: "Rechner", systemPrompt: "Provider-Rolle" },
			{ label: "Modell", systemPrompt: "Modell-Rolle" },
			{ label: "Task" },
		])
		expect(out).toBe("Modell-Rolle")
	})

	it("hängt jede ausgefüllte plan.md als verbindliche Anweisung an", () => {
		const out = composeSystemPrompt([
			{ label: "Modell qwen3", plan: "## Leitplanken\n\n- Antworte auf Deutsch." },
			{ label: "Spezialist Code-Dev", plan: "## Auftrag\n\nDu reviewst Diffs.", systemPrompt: "Rolle" },
		])
		expect(out.startsWith("Rolle")).toBe(true)
		expect(out).toContain("Verbindliche Arbeitsanweisung")
		// Reihenfolge: allgemein (Modell) vor spezifisch (Spezialist).
		expect(out.indexOf("Modell qwen3")).toBeLessThan(out.indexOf("Spezialist Code-Dev"))
		expect(out).toContain("Antworte auf Deutsch.")
		expect(out).toContain("Du reviewst Diffs.")
	})

	it("unausgefüllte Vorlagen erzeugen keinen Anweisungs-Block", () => {
		const out = composeSystemPrompt([
			{ label: "Spezialist X", plan: defaultDoc("plan", "agent", "X", "2026-08-23"), systemPrompt: "Rolle" },
		])
		expect(out).toBe("Rolle")
	})
})

describe("Dokument-Vorlagen", () => {
	it("füllt {{name}}, {{datum}} und {{datei}}", () => {
		const out = renderDocTemplate(
			"{{datei}} für {{name}} am {{datum}}",
			"Code-Dev",
			"2026-08-23T10:00:00Z",
			"plan",
		)
		expect(out).toBe("plan.md für Code-Dev am 2026-08-23")
	})

	it("eine eingestellte Vorlage schlägt die eingebaute", () => {
		const custom = defaultDoc("plan", "agent", "Code-Dev", "2026-08-23", {
			agent: { plan: "# {{name}}\n\nImmer testen." },
		})
		expect(custom).toBe("# Code-Dev\n\nImmer testen.")
		// Andere Besitzer-Art bleibt bei der eingebauten Vorlage.
		expect(defaultDoc("plan", "instance", "qwen3", "2026-08-23", { agent: { plan: "x" } })).toContain(
			"## 1. Auftrag",
		)
	})

	it("defaultAgentDoc bleibt der Kurzweg für Spezialisten", () => {
		expect(defaultAgentDoc("changelog", "Code-Dev", "2026-08-23")).toContain("Spezialist angelegt")
	})
})

describe("extractDirective: Struktur bleibt erhalten", () => {
	it("lässt Code-Blöcke unangetastet", () => {
		const md = [
			"# plan.md — Test",
			"",
			"## Beispiel",
			"",
			"So sieht ein sicherer Aufruf aus:",
			"",
			"```ts",
			"const safe = escape(input)",
			"",
			"return safe",
			"```",
			"",
			"Danach prüfen.",
		].join("\n")
		const out = extractDirective(md) ?? ""
		// Beide Zaun-Zeilen müssen stehen bleiben, sonst bricht der Block auf.
		expect(out.split("\n").filter((l) => l.startsWith("```"))).toHaveLength(2)
		expect(out).toContain("const safe = escape(input)")
		// Auch die Leerzeile *innerhalb* des Blocks bleibt erhalten.
		expect(out).toContain("const safe = escape(input)\n\nreturn safe")
	})

	it("behält Gliederungs-Überschriften, unter denen Unterabschnitte hängen", () => {
		const md = [
			"# plan.md — Test",
			"",
			"# 2. Vorgehen",
			"",
			"## Phase 1",
			"",
			"Zuerst die Angriffsfläche erfassen.",
		].join("\n")
		const out = extractDirective(md) ?? ""
		expect(out).toContain("# 2. Vorgehen")
		expect(out).toContain("## Phase 1")
		expect(out).toContain("Zuerst die Angriffsfläche erfassen.")
	})

	it("wirft eine Überschrift weg, deren Abschnitt wirklich leer ist", () => {
		const md = [
			"## 1. Auftrag",
			"",
			"Echte Anweisung.",
			"",
			"## 2. Vorgehen",
			"",
			"- Schritt 1",
			"- Schritt 2",
		].join("\n")
		const out = extractDirective(md) ?? ""
		expect(out).toContain("## 1. Auftrag")
		expect(out).toContain("Echte Anweisung.")
		// Der zweite Abschnitt bestand nur aus Vorlagen-Platzhaltern.
		expect(out).not.toContain("## 2. Vorgehen")
	})
})
