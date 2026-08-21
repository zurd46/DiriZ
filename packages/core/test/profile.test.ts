import type { Task } from "@diriz/shared"
import { describe, expect, it } from "vitest"
import { extractProfile } from "../src/routing/profile.js"

function task(prompt: string, overrides?: Partial<Task["metadata"]>): Task {
	return {
		id: "t1",
		title: "Test",
		prompt,
		metadata: { privacy: "local-only", mode: "auto", ...overrides },
		status: "draft",
		createdAt: new Date().toISOString(),
	}
}

describe("profile: extractProfile", () => {
	it("erkennt Code-Tasks (hartes `code`-Gate)", () => {
		const profile = extractProfile(task("Fix this bug in my python code:\n```python\ndef f(): pass\n```"))
		expect(profile.requiredCapabilities).toContain("code")
	})

	it("gibt für einfache Übersetzungen keine Pflicht-Capabilities", () => {
		const profile = extractProfile(task("Übersetze diesen Satz ins Englische: Hallo Welt"))
		expect(profile.requiredCapabilities).toHaveLength(0)
	})

	it("schätzt Tokens konservativ", () => {
		const profile = extractProfile(task("a".repeat(3500)))
		expect(profile.estTokens).toBeGreaterThan(1000)
	})

	it("überträgt Pinning & Budget aus den Metadaten", () => {
		const profile = extractProfile(
			task("whatever", {
				mode: "pinned",
				preferredProviderId: "prov-1",
				preferredModelId: "llama-3",
				budgetUsd: 0.5,
				privacy: "allow-cloud",
			}),
		)
		expect(profile.mode).toBe("pinned")
		expect(profile.pinnedProviderId).toBe("prov-1")
		expect(profile.pinnedModelId).toBe("llama-3")
		expect(profile.budgetUsd).toBe(0.5)
		expect(profile.privacy).toBe("allow-cloud")
	})
})
