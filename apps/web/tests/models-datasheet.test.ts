/**
 * LLM-Modelle: die Ansicht, in der das Datenblatt eines Modells bearbeitet wird.
 *
 * Ohne angebundenen Rechner gibt es keine Modelle — geprüft wird deshalb der
 * leere Zustand, der Menüeintrag und dass die Ansicht ihre eigene Sprache
 * spricht (Datenblatt statt Auftrag). Genau das war der Anlass für diese
 * Trennung.
 */

import { expect, test } from "@playwright/test"

/** Die Einführung erscheint beim ersten Start und fängt sonst jeden Klick ab. */
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("diriz_onboarded", "1"))
})

test("LLM-Modelle ist über das Menü erreichbar und erklärt sich selbst", async ({ page }) => {
	await page.goto("/dashboard")
	await page.getByRole("button", { name: "LLM-Modelle" }).click()

	await expect(page).toHaveURL(/\/models$/)
	await expect(page.locator("main h1")).toHaveText("LLM-Modelle")
	await expect(page.locator(".page-sub")).toContainText("Datenblatt")
	await expect(page.getByPlaceholder("Modell oder Datenblatt suchen …")).toBeVisible()
})

test("Dokumente führt keine Modelle mehr — die haben ihre eigene Ansicht", async ({ page }) => {
	await page.goto("/docs")
	await expect(page.locator("main h1")).toHaveText("Dokumente")
	// Die Gruppen-Überschrift „Modelle“ gehört nicht mehr hierher.
	await expect(page.locator(".docs-group", { hasText: /^Modelle/ })).toHaveCount(0)
	await expect(page.locator(".page-sub")).toContainText("LLM-Modelle")
})
