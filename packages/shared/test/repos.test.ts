/**
 * Git-Hilfen aus `repos.ts` — vor allem die Eindeutigkeit des Arbeitsbranches.
 */

import { describe, expect, it } from "vitest"
import { workBranchName } from "../src/repos.js"

/**
 * Der Arbeitsbranch muss eindeutig sein. Zwei Tasks mit ähnlichem Titel im
 * selben Repository erzeugten sonst denselben Branch — Git verweigert den
 * zweiten Worktree („is already used by worktree at …“) und die Task ist tot.
 */
describe("workBranchName", () => {
	it("hängt die Kurz-ID der Task an", () => {
		expect(workBranchName("README Ausbau", "12bc228c-1111-2222-3333-444455556666")).toBe(
			"diriz/readme-ausbau-12bc228c",
		)
	})

	it("unterscheidet Tasks mit gleichem Titel", () => {
		const a = workBranchName("Gleicher Titel", "aaaaaaaa-0000-0000-0000-000000000000")
		const b = workBranchName("Gleicher Titel", "bbbbbbbb-0000-0000-0000-000000000000")
		expect(a).not.toBe(b)
	})

	it("kürzt lange Titel, bleibt aber eindeutig", () => {
		const lang = "Probleme vom Typ Händlereinträge für strukturierte Daten in der Übersicht und mehr"
		const a = workBranchName(lang, "12bc228c-0000-0000-0000-000000000000")
		const b = workBranchName(lang, "a4972d9b-0000-0000-0000-000000000000")
		expect(a).not.toBe(b)
		expect(a.startsWith("diriz/probleme-vom-typ-h-ndlereintr-ge-f-r-strukturierte-daten")).toBe(true)
	})

	it("bleibt ohne ID rückwärtskompatibel", () => {
		expect(workBranchName("README Ausbau")).toBe("diriz/readme-ausbau")
	})
})
