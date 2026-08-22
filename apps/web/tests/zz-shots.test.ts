import { expect, test } from "@playwright/test"

const VIEWS = ["Dashboard", "Provider", "Agenten", "Tasks", "Workspace", "Logs", "Einstellungen"]

test("Screenshots aller Ansichten", async ({ page }) => {
	const errors: string[] = []
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text())
	})
	page.on("pageerror", (e) => errors.push(String(e)))

	await page.setViewportSize({ width: 1440, height: 950 })
	await page.goto("/")
	await page.waitForLoadState("networkidle")

	const onboarding = page.locator(".onboarding")
	if (await onboarding.isVisible()) {
		await page.screenshot({ path: "test-results/shot-onboarding.png" })
		await page.click('button:has-text("Überspringen")')
	}

	for (const v of VIEWS) {
		await page.getByRole("button", { name: v }).click()
		await page.waitForTimeout(700)
		await page.screenshot({ path: `test-results/shot-${v}.png`, fullPage: true })
	}

	// Formulare aufklappen, damit auch sie im Bild sind.
	await page.getByRole("button", { name: "Tasks" }).click()
	await page.click('button:has-text("+ Neue Task")')
	await page.click('button:has-text("Erweiterte Settings")')
	await page.waitForTimeout(400)
	await page.screenshot({ path: "test-results/shot-Task-Form.png", fullPage: true })

	await page.getByRole("button", { name: "Agenten" }).click()
	await page.click('button:has-text("Spezialist anlegen")')
	await page.waitForTimeout(400)
	await page.screenshot({ path: "test-results/shot-Agent-Form.png", fullPage: true })

	// Schmale Breite: eingeklappte Sidebar prüfen.
	await page.setViewportSize({ width: 760, height: 900 })
	await page.getByRole("button", { name: "Dashboard" }).click()
	await page.waitForTimeout(500)
	await page.screenshot({ path: "test-results/shot-narrow.png", fullPage: true })

	expect(errors, `Konsolenfehler: ${errors.join(" | ")}`).toEqual([])
})
